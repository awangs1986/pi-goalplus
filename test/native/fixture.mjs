import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export async function until(condition, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await delay(25);
  }
  throw new Error("Timed out waiting for " + description);
}

export async function modelServer(onRequest) {
  let calls = 0;
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const id = ++calls;
      const reply = await onRequest(body, id);
      if (reply.error) {
        response.writeHead(reply.error, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.message ?? "Fixture error" } }));
        return;
      }
      const toolCalls = reply.tools ?? (reply.tool ? [reply] : []);
      const delta = toolCalls.length
        ? { role: "assistant", tool_calls: toolCalls.map((call, index) => ({
            index, id: "call_" + id + "_" + index, type: "function",
            function: { name: call.tool, arguments: JSON.stringify(call.args ?? {}) },
          })) }
        : { role: "assistant", content: reply.text ?? "Fixture completed this turn." };
      const usage = reply.usage ?? 10;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [{ index: 0, delta, finish_reason: null }, {
        index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop",
      }]) {
        response.write("data: " + JSON.stringify({
          id: "fixture-" + id, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice],
          usage: { prompt_tokens: usage, completion_tokens: 3, total_tokens: usage + 3 },
        }) + "\n\n");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end("Test model fixture failure");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    assertHealthy() { if (failures.length) throw failures[0]; },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function toolNames(body) {
  return (body.tools ?? []).map(tool => tool.function?.name);
}

export function lastTool(body) {
  const index = body.messages.findLastIndex(message => message.role === "tool");
  const message = body.messages[index];
  if (!message) return undefined;
  const call = body.messages.slice(0, index).reverse().flatMap(m => m.tool_calls ?? [])
    .find(item => item.id === message.tool_call_id);
  return { id: message.tool_call_id, name: call?.function?.name, text: message.content };
}

export async function rpcFixture(directory, cli, packages, baseUrl, extensions = [], cliArgs = []) {
  const agent = join(directory, "agent");
  const cwd = join(directory, "work");
  const session = join(directory, "session.jsonl");
  await mkdir(agent, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    packages, compaction: { enabled: false, keepRecentTokens: 256 }, retry: { enabled: false },
  }));
  await writeFile(join(agent, "models.json"), JSON.stringify({
    providers: { fixture: {
      baseUrl, api: "openai-completions", apiKey: "fixture-key", models: [
        { id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 2048 },
      ],
    } },
  }));
  return { cwd, session, launch };
  function launch() {
    const child = spawn(process.execPath, [
      cli, "--mode", "rpc", "--offline", "--no-skills",
      "--provider", "fixture", "--model", "fixture", "--session", session,
      ...extensions.flatMap(extension => ["-e", extension]),
      ...cliArgs,
    ], {
      cwd, env: {
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        NO_COLOR: "1",
      }, stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let serial = 0;
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-1800); });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", line => {
      try { events.push(JSON.parse(line)); } catch { /* native diagnostics are not RPC frames */ }
    });
    const exited = new Promise(resolve => child.once("close", resolve));
    return {
      events,
      async command(type, params = {}) {
        const id = String(++serial);
        child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
        const frame = await until(() => {
          if (child.exitCode !== null) throw new Error("Pi exited: " + stderr);
          return events.find(event => event.type === "response" && event.id === id);
        }, type + " response");
        assert.equal(frame.success, true, JSON.stringify(frame));
        return frame.data;
      },
      async close(signal = "SIGTERM") {
        child.kill(signal);
        await exited;
        const errors = events.filter(event => event.type === "extension_error");
        assert.deepEqual(errors, [], stderr);
      },
    };
  }
}
