import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lastTool, modelServer, rpcFixture, toolNames, until } from "./fixture.mjs";

const version = process.env.GOALPLUS_PI_VERSION ?? "1.6.0";
const scratch = await mkdtemp(join(tmpdir(), "pi-goalplus-native-"));
const goal = {
  objective: "Validate both GoalPlus fixtures",
  constraints: [],
  criteria: [
    { id: "A", requirement: "a.txt contains verified-a", verification: "Read a.txt" },
    { id: "B", requirement: "b.txt contains verified-b", verification: "Read b.txt" },
  ],
};
try {
  const installed = await install();
  await longGoal(installed);
  await compactAndRestore(installed, false);
  await compactAndRestore(installed, true);
  console.log("PI_GOALPLUS_NATIVE_OK " + version);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function install() {
  const [packed] = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--pack-destination", scratch,
  ], { encoding: "utf8" }));
  const consumer = join(scratch, "consumer");
  execFileSync("npm", [
    "install", "--prefix", consumer, "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund",
    "@earendil-works/pi-coding-agent@" + version, join(scratch, packed.filename),
  ], { stdio: "pipe" });
  const packages = join(consumer, "node_modules");
  const plugin = join(packages, "pi-goalplus");
  const manifest = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
  const cli = join(packages, "@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), version);
  return { cli, extensions: manifest.pi.extensions.map(path => resolve(plugin, path)) };
}

function readScope(body) {
  const result = lastTool(body);
  assert.equal(result?.name, "goalplus_read");
  const value = JSON.parse(result.text);
  return { goalId: value.goalId, revision: value.revision, runId: value.runId };
}

function checkpoint(scope, stage, criteria) {
  return { tool: "goalplus_checkpoint", args: { ...scope, stage, criteria, constraints: [] } };
}

function verified(id, state, body, observed) {
  const check = lastTool(body);
  assert.equal(check?.name, "read");
  assert.match(check.text, new RegExp(observed));
  return { id, state, source: check.id, observed };
}

function strip(rpc, patterns) {
  return rpc.events.find(event => event.type === "extension_ui_request" && event.method === "setWidget" &&
    patterns.every(pattern => pattern.test(JSON.stringify(event))));
}

async function longGoal(installed) {
  let scope, a, b;
  const seenRuns = new Set();
  const planned = [
    // First stage reports only prose after reading. This does not complete the Goal.
    readGoal, body => { open(body); return { text: "I will verify both criteria." }; },
    readGoal, body => { open(body); return read("a.txt"); },
    body => checkpoint(scope, "Check A", [verified("A", "pass", body, "verified-a"), { id: "B", state: "reopen" }]),
    okayCheckpoint,
    // Later work breaks A. The broken work must not complete, even after A used to pass.
    readGoal, body => { open(body); return { tool: "write", args: { path: "a.txt", content: "broken-a" } }; },
    () => read("a.txt"),
    body => checkpoint(scope, "Detect regression", [verified("A", "fail", body, "broken-a"), { id: "B", state: "reopen" }]),
    body => { assert.equal(lastTool(body)?.name, "goalplus_checkpoint"); return { tool: "goalplus_complete", args: scope }; },
    body => {
      const verdict = lastTool(body);
      assert.equal(verdict?.name, "goalplus_complete");
      assert.match(verdict.text, /current|not|requires|cannot|fail/i);
      return { text: "Criterion A regressed and needs repair." };
    },
    readGoal, body => { open(body); return { tool: "write", args: { path: "a.txt", content: "verified-a" } }; },
    () => read("a.txt"),
    body => checkpoint(scope, "Repair A", [verified("A", "pass", body, "verified-a"), { id: "B", state: "reopen" }]),
    okayCheckpoint,
    readGoal, body => { open(body); return read("a.txt"); },
    body => { a = verified("A", "pass", body, "verified-a"); return read("b.txt"); },
    body => { b = verified("B", "pass", body, "verified-b"); return checkpoint(scope, "Final acceptance", [a, b]); },
    body => { assert.equal(lastTool(body)?.name, "goalplus_checkpoint"); return { tool: "goalplus_complete", args: scope }; },
    body => { assert.equal(lastTool(body)?.name, "goalplus_complete"); return { text: "All required checks passed." }; },
  ];
  function open(body) {
    scope = readScope(body);
    assert.ok(scope.runId);
    assert.ok(!seenRuns.has(scope.runId), "continuations have distinct native dispatch identities");
    seenRuns.add(scope.runId);
  }
  let ready = false;
  const server = await modelServer(body => {
    if (!ready) {
      assert.ok(!toolNames(body).some(name => name.startsWith("goalplus_")));
      return { text: "Ordinary Pi Work" };
    }
    assert.ok(toolNames(body).includes("goalplus_read"));
    const next = planned.shift();
    assert.ok(next, "an extra native request started after completion");
    return next(body);
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "long"), installed.cli, installed.extensions, server.baseUrl);
    await writeFile(join(fixture.cwd, "a.txt"), "verified-a");
    await writeFile(join(fixture.cwd, "b.txt"), "verified-b");
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "Ordinary Work" });
    await until(() => rpc.events.some(event => event.type === "agent_settled"), "ordinary settled turn");
    assert.ok(!strip(rpc, [/Validate both/]));
    ready = true;
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/Validate both/, /complete/i, /2\s*\/\s*2/]);
    }, "completed Goal widget");
    assert.equal(seenRuns.size, 5);
    assert.equal(planned.length, 0);
    await rpc.command("get_state");
    server.assertHealthy();
    assert.equal(await readFile(join(fixture.cwd, "a.txt"), "utf8"), "verified-a");
    console.log("PASS native remote-model transport: 4 automatic continuations, regression detected and repaired, Goal complete");
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}

async function compactAndRestore(installed, custom) {
  const key = custom ? "handoff" : "compact";
  let stage = "before";
  let scope, previousId, sawCompaction = false;
  const stages = {
    before: [
      readGoal,
      body => {
        scope = readScope(body);
        previousId = scope.goalId;
        return { tool: "goalplus_block", args: {
          ...scope, reason: "Fixture awaits approval", dependency: "approval", evidence: "Waiting for fixture user action",
        } };
      },
      () => ({ text: "Waiting for approval." }),
    ],
    after: [
      readGoal,
      body => {
        scope = readScope(body);
        assert.equal(scope.goalId, previousId);
        return { tool: "goalplus_block", args: {
          ...scope, reason: "Fixture restored the original Goal", dependency: "user", evidence: "Acceptance was inspected",
        } };
      },
      () => ({ text: "Preserved confirmed requirements." }),
    ],
  };
  const server = await modelServer(body => {
    if (!toolNames(body).length) {
      sawCompaction = true;
      return { text: "Fixture native transcript summary" };
    }
    if (!toolNames(body).includes("goalplus_read")) return { text: "Start fixture session." };
    const next = stages[stage].shift();
    assert.ok(next, "unexpected resumed task");
    return next(body);
  });
  let rpc;
  try {
    const extensions = [...installed.extensions];
    if (custom) {
      const customExtension = join(scratch, "handoff-fixture.mjs");
      await writeFile(customExtension, [
        'export default pi => pi.on("session_before_compact", event => {',
        '  if (event.customInstructions !== "fixture-handoff") return;',
        '  return { compaction: { summary: "A separate extension owns this summary.",',
        '    firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };',
        '});',
      ].join("\n"));
      extensions.push(customExtension);
    }
    const fixture = await rpcFixture(join(scratch, key), installed.cli, extensions, server.baseUrl);
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "Persist this native session" });
    await until(() => rpc.events.some(event => event.type === "agent_settled"), "initial RPC settlement");
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/blocked/i, /awaits approval/i]) || (stages.before.length === 0 &&
        rpc.events.filter(event => event.type === "agent_settled").length === 2);
    }, "blocked Goal");
    const compaction = await rpc.command("compact", custom ? { customInstructions: "fixture-handoff" } : {});
    assert.match(compaction.summary, custom ? /separate extension/ : /native transcript/);
    assert.equal(sawCompaction, !custom);
    await rpc.close();
    rpc = undefined;
    stage = "after";
    rpc = fixture.launch();
    await rpc.command("get_state");
    await until(() => strip(rpc, [/Validate both/, /blocked/i]), "persisted Goal widget after restart");
    await rpc.command("prompt", { message: "/goal resume" });
    await until(() => {
      server.assertHealthy();
      return stages.after.length === 0 && rpc.events.some(event => event.type === "agent_settled");
    }, "restored Goal reading original requirements");
    console.log("PASS " + (custom ? "extension-owned compaction" : "native compaction") + " and session reopen");
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}

function readGoal() { return { tool: "goalplus_read" }; }
function read(path) { return { tool: "read", args: { path } }; }
function okayCheckpoint(body) {
  assert.equal(lastTool(body)?.name, "goalplus_checkpoint");
  return { text: "Stage checked." };
}
