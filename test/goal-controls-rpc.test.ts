import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

type Frame = {
  type: string;
  id?: string;
  method?: string;
  widgetKey?: string;
  widgetLines?: string[];
  message?: string;
  success?: boolean;
  error?: string;
  command?: string;
  data?: {
    commands?: Array<{ name: string }>;
    sessionFile?: string;
  };
  aborted?: boolean;
};
type Waiter = { match: (frame: Frame) => boolean; accept: (frame: Frame) => void };
const extension = fileURLToPath(new URL("fixtures/controls-extension.ts", import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))), "cli.js");
const definition = {
  objective: "Fix the launch checks",
  constraints: ["Keep the existing command names"],
  criteria: [{ id: "launch", requirement: "The launch check succeeds", verification: "Run npm run check" }]
};

async function withPi(
  task: (rpc: {
    send(value: Record<string, unknown>): void;
    command(type: string, data?: Record<string, unknown>): Promise<Frame>;
    wait(match: (frame: Frame) => boolean): Promise<Frame>;
    frames: Frame[];
  }) => Promise<void>,
  hold = false
) {
  const root = await mkdtemp(join(tmpdir(), "goalplus-controls-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    child = spawn(process.execPath, [
      cli, "--mode", "rpc", "--session-dir", join(root, "sessions"), "--no-extensions",
      "-e", extension, "--provider", "goal-controls-fixture", "--model", "fixture"
    ], {
      cwd,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        GOAL_CONTROLS_HOLD: hold ? "1" : "0"
      }
    });
    const processHandle = child;
    const frames: Frame[] = [];
    const waiters = new Set<Waiter>();
    let tail = "";
    let stderr = "";
    let nextId = 0;
    processHandle.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      tail += chunk;
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        const frame: Frame = JSON.parse(line);
        frames.push(frame);
        for (const waiter of waiters) {
          if (waiter.match(frame)) waiter.accept(frame);
        }
      }
    });
    processHandle.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const send = (value: Record<string, unknown>) => {
      processHandle.stdin.write(JSON.stringify(value) + "\n");
    };
    const wait = (match: (frame: Frame) => boolean): Promise<Frame> => {
      const seen = frames.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(Error(`No matching Pi RPC frame. Diagnostics: ${stderr}`));
        }, 3500);
        const waiter: Waiter = {
          match,
          accept(frame) {
            clearTimeout(timeout);
            waiters.delete(waiter);
            resolve(frame);
          }
        };
        waiters.add(waiter);
      });
    };
    const command = (type: string, data?: Record<string, unknown>) => {
      const id = `controls-${++nextId}`;
      send({ ...data, id, type });
      return wait(frame => frame.id === id && frame.type === "response");
    };
    const commands = await command("get_commands");
    expect(commands.data?.commands?.map(item => item.name), stderr).toContain("goal");
    await task({ frames, send, wait, command });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.stdin.end();
      const force = setTimeout(() => child?.kill("SIGKILL"), 1000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("reviewing then cancelling saves no Goal and starts no native turn", async () => {
  await withPi(async rpc => {
    const start = rpc.command("prompt", { message: "/goal Fix the launch checks" });
    const editor = await rpc.wait(frame => frame.method === "editor");
    rpc.send({ type: "extension_ui_response", id: editor.id, value: JSON.stringify(definition) });
    const confirmation = await rpc.wait(frame => frame.method === "confirm");
    rpc.send({ type: "extension_ui_response", id: confirmation.id, confirmed: false });
    expect((await start).success).toBe(true);
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.method === "notify" && frame.message?.includes("No Goal") === true);
    expect(rpc.frames.some(frame => frame.type === "agent_start")).toBe(false);
  });
}, 8000);

test("a confirmed Goal starts one turn and a native session switch restores its requirements", async () => {
  await withPi(async rpc => {
    const start = rpc.command("prompt", { message: "/goal Fix the launch checks" });
    const editor = await rpc.wait(frame => frame.method === "editor");
    rpc.send({ type: "extension_ui_response", id: editor.id, value: JSON.stringify(definition) });
    const confirmation = await rpc.wait(frame => frame.method === "confirm");
    expect(confirmation.message).toContain("The launch check succeeds");
    expect(confirmation.message).toContain("Run npm run check");
    rpc.send({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
    expect((await start).success).toBe(true);
    await rpc.wait(frame => frame.type === "agent_settled");
    const session = await rpc.command("get_state");
    expect(session.data?.sessionFile).toMatch(/\.jsonl$/);
    expect((await rpc.command("new_session")).success).toBe(true);
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.method === "notify" && frame.message?.includes("No Goal") === true);
    const count = rpc.frames.length;
    expect((await rpc.command("switch_session", { sessionPath: session.data?.sessionFile })).success).toBe(true);
    expect(rpc.frames.slice(count)).toContainEqual(expect.objectContaining({
      widgetKey: "pi-goalplus",
      widgetLines: expect.arrayContaining([expect.stringContaining("0/1 verified · Fix the launch checks")])
    }));
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.method === "notify" && frame.message?.includes("Keep the existing command names") === true);
    expect(rpc.frames.filter(frame => frame.type === "agent_start")).toHaveLength(1);
  });
}, 8000);

test("stop pauses the Goal before interrupting its in-flight native turn", async () => {
  await withPi(async rpc => {
    expect((await rpc.command("prompt", { message: `/goal start ${JSON.stringify(definition)}` })).success).toBe(true);
    await rpc.wait(frame => frame.type === "agent_start");
    expect((await rpc.command("prompt", { message: "/goal stop" })).success).toBe(true);
    const settled = await rpc.wait(frame => frame.type === "agent_settled");
    expect(settled.aborted).toBe(true);
    const paused = rpc.frames.find(frame => frame.method === "setWidget" && frame.widgetLines?.some(line => line.includes("[Paused]")));
    expect(paused).toBeDefined();
    if (paused) expect(rpc.frames.indexOf(paused)).toBeLessThan(rpc.frames.indexOf(settled));
  }, true);
}, 8000);

test("an exhausted Goal cannot resume until a user revises its budget", async () => {
  await withPi(async rpc => {
    const budgeted = { ...definition, budgetTokens: 10 };
    expect((await rpc.command("prompt", { message: `/goal start ${JSON.stringify(budgeted)}` })).success).toBe(true);
    await rpc.wait(frame => frame.type === "agent_settled");
    expect((await rpc.command("prompt", { message: "/fixture-budget" })).success).toBe(true);
    expect((await rpc.command("prompt", { message: "/goal resume" })).success).toBe(true);
    await rpc.wait(frame => frame.type === "extension_error" && frame.error?.includes("Increase or remove") === true);
    expect((await rpc.command("prompt", { message: `/goal edit ${JSON.stringify(definition)}` })).success).toBe(true);
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.method === "notify" && frame.message?.includes("Paused · revision 2") === true);
    expect(rpc.frames.filter(frame => frame.type === "agent_start")).toHaveLength(1);
    expect((await rpc.command("prompt", { message: "/goal resume" })).success).toBe(true);
    const eventsAfterFirstRun = rpc.frames.slice(rpc.frames.findIndex(frame => frame.type === "agent_settled") + 1);
    expect(eventsAfterFirstRun).toContainEqual(expect.objectContaining({
      widgetKey: "pi-goalplus",
      widgetLines: expect.arrayContaining([expect.stringContaining("[Active]")])
    }));
  });
}, 8000);

test("a late confirmation cannot replace a separately started Goal", async () => {
  await withPi(async rpc => {
    const staleStart = rpc.command("prompt", { message: "/goal Stale draft" });
    const editor = await rpc.wait(frame => frame.method === "editor");
    const stale = { ...definition, objective: "Stale draft" };
    rpc.send({ type: "extension_ui_response", id: editor.id, value: JSON.stringify(stale) });
    const confirmation = await rpc.wait(frame => frame.method === "confirm");
    expect((await rpc.command("prompt", { message: `/goal start ${JSON.stringify(definition)}` })).success).toBe(true);
    await rpc.wait(frame => frame.type === "agent_settled");
    rpc.send({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
    expect((await staleStart).success).toBe(true);
    await rpc.wait(frame => frame.type === "extension_error" && frame.error?.includes("session changed") === true);
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.method === "notify" && frame.message?.includes("Fix the launch checks") === true);
    expect(rpc.frames.filter(frame => frame.type === "agent_start")).toHaveLength(1);
  });
}, 8000);

test("a malformed latest snapshot fails closed and can be cleared explicitly", async () => {
  await withPi(async rpc => {
    expect((await rpc.command("prompt", { message: `/goal start ${JSON.stringify(definition)}` })).success).toBe(true);
    await rpc.wait(frame => frame.type === "agent_settled");
    expect((await rpc.command("prompt", { message: "/fixture-invalid" })).success).toBe(true);
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.type === "extension_error" && frame.error?.includes("incompatible or damaged") === true);
    expect((await rpc.command("prompt", { message: "/goal clear" })).success).toBe(true);
    expect((await rpc.command("prompt", { message: "/goal status" })).success).toBe(true);
    await rpc.wait(frame => frame.method === "notify" && frame.message?.includes("No Goal") === true);
  });
}, 8000);
