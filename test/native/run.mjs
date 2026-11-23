import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lastTool, modelServer, rpcFixture, toolNames, until } from "./fixture.mjs";

const version = process.argv[2] ?? process.env.GOALPLUS_PI_VERSION ?? "1.6.0";
const scratch = await mkdtemp(join(tmpdir(), "pi-goalplus-native-"));
const goal = {
  objective: "Validate both GoalPlus fixtures",
  constraints: [],
  criteria: [
    { id: "A", requirement: "a.txt contains verified-a", verification: "Read a.txt" },
    { id: "B", requirement: "b.txt contains verified-b", verification: "Read b.txt" },
  ],
};
const tasks = [
  { title: "Fix and verify a.txt", criteria: ["A"] },
  { title: "Fix b.txt and verify both fixtures", criteria: ["A", "B"] },
];
const unverified = goal.criteria.map(({ id }) => ({ id, state: "reopen" }));
try {
  const installed = await install();
  await resumeAfterFailure(installed);
  await compactBeforeNextTask(installed);
  await compactBeforeNextTask(installed, { key: "at-70-percent", usage: 44_797, estimate: 30_000, expected: false });
  await compactBeforeNextTask(installed, { key: "enough-space", usage: 47_000, estimate: 2_000, expected: false });
  await orderedTasks(installed);
  await longGoal(installed);
  await parallelEvidence(installed);
  await compactAndRestore(installed, false);
  await compactAndRestore(installed, true);
  await interruptedDispatch(installed);
  await budgetLimit(installed);
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
  const cli = join(packages, "@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), version);
  const registration = join(scratch, "registration");
  await mkdir(registration, { recursive: true });
  const env = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: registration, PI_OFFLINE: "1" };
  execFileSync(process.execPath, [cli, "install", plugin], { env, encoding: "utf8", cwd: registration });
  const listing = execFileSync(process.execPath, [cli, "list"], { env, encoding: "utf8", cwd: registration });
  assert.match(listing, /pi-goalplus/);
  console.log("PASS native Pi package registration and listing");
  const settings = JSON.parse(await readFile(join(registration, "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1);
  const registrations = settings.packages.map(entry => typeof entry === "string"
    ? resolve(registration, entry)
    : { ...entry, source: resolve(registration, entry.source) });
  return { cli, packages: registrations };
}

function readScope(body) {
  const result = lastTool(body);
  assert.equal(result?.name, "goalplus_read");
  const value = JSON.parse(result.text);
  return { goalId: value.goalId, revision: value.revision, runId: value.runId };
}

function checkpoint(scope, stage, criteria, taskCompleted) {
  return { tool: "goalplus_checkpoint", args: { ...scope, stage, criteria, constraints: [], taskCompleted } };
}

function planTasks(scope, plan = tasks) {
  return { tool: "goalplus_tasks", args: { ...scope, plan } };
}

function alignTask(scope, number) {
  return { tool: "goalplus_tasks", args: { ...scope, align: { number, rationale: tasks[number - 1].title + " as required by the original fixture Goal." } } };
}

function write(path, content) {
  return { tool: "write", args: { path, content } };
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

async function resumeAfterFailure(installed) {
  let scope, a;
  let resuming = false;
  const privateErrorDetail = "fixture-private-provider-detail";
  const before = [
    readGoal,
    body => { scope = readScope(body); return planTasks(scope); },
    readGoal,
    () => alignTask(scope, 1),
    () => write("a.txt", "verified-a"),
    () => read("a.txt"),
    body => checkpoint(scope, "Verified A", [verified("A", "pass", body, "verified-a"), unverified[1]], 1),
    () => ({ error: 400, message: `Fixture interrupted the agent after task one: ${privateErrorDetail}` }),
  ];
  const after = [
    readGoal,
    body => {
      const resumed = JSON.parse(lastTool(body).text);
      assert.equal(resumed.goalId, scope.goalId);
      assert.equal(resumed.revision, scope.revision);
      assert.notEqual(resumed.runId, scope.runId);
      assert.equal(resumed.objective, goal.objective);
      assert.deepEqual(resumed.plan, { tasks, completed: 1 });
      assert.ok(resumed.evidence.some(item => item.criterionId === "A" && item.verdict === "pass"));
      scope = readScope(body);
      return alignTask(scope, 2);
    },
    () => write("b.txt", "verified-b"),
    () => read("a.txt"),
    body => { a = verified("A", "pass", body, "verified-a"); return read("b.txt"); },
    body => checkpoint(scope, "Verified both fixtures", [a, verified("B", "pass", body, "verified-b")]),
    () => ({ tool: "goalplus_complete", args: scope }),
    () => ({ text: "Both tasks verified." }),
  ];
  const server = await modelServer(body => {
    if (!resuming && !toolNames(body).includes("goalplus_read")) return { text: "Ordinary Pi response." };
    assert.ok(toolNames(body).includes("goalplus_read"), '"继续" must resume the saved Goal with its tools');
    if (resuming) {
      const continuationInputs = body.messages.filter(message => message.role === "user" &&
        JSON.stringify(message.content).includes('"继续"'));
      assert.equal(continuationInputs.length, 1, '"继续" during recovery must be consumed as a Goal control');
    }
    const action = (resuming ? after : before).shift();
    assert.ok(action, "unexpected Goal continuation");
    return action(body);
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "resume-failure"), installed.cli, installed.packages, server.baseUrl);
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "/goal logs" });
    await until(() => rpc.events.find(event => event.method === "notify" && event.message?.includes("No diagnostic events")),
      "empty Goal log before any work");
    assert.equal(rpc.events.some(event => event.type === "agent_start"), false);
    await rpc.command("prompt", { message: "继续" });
    await until(() => rpc.events.some(event => event.type === "agent_settled"), "ordinary prompt without a Goal");
    assert.ok(!strip(rpc, [/Validate both/]), "plain input must not create a new Goal");

    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/\[Blocked\]/, /Task 2\/2/]);
    }, "saved task after native provider interruption");
    await rpc.close();
    rpc = fixture.launch();
    await rpc.command("get_state");
    await rpc.command("prompt", { message: "/goal logs" });
    const diagnostic = await until(() => rpc.events.find(event => event.type === "extension_error" ||
      (event.method === "notify" && event.message?.startsWith("Goal logs"))), "Goal logs after reopening the failed run");
    assert.equal(diagnostic.method, "notify");
    assert.match(diagnostic.message, /Task 2\/2.*Provider.*HTTP 400.*Blocked/i);
    assert.doesNotMatch(diagnostic.message, new RegExp(privateErrorDetail));
    await rpc.command("prompt", { message: "/goal logs 1" });
    const latest = await until(() => rpc.events.find(event => event !== diagnostic && event.method === "notify" &&
      event.message?.startsWith("Goal logs")), "one diagnostic event");
    assert.equal(latest.message.split("\n").length, 2);
    assert.match(latest.message, /HTTP 400/);
    assert.equal(rpc.events.some(event => event.type === "agent_start"), false);
    resuming = true;
    await rpc.command("prompt", { message: "继续" });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/\[Complete\]/, /Task 2\/2/]);
    }, "completed original Goal after sending 继续");
    assert.equal(before.length + after.length, 0);
    assert.equal(await readFile(join(fixture.cwd, "b.txt"), "utf8"), "verified-b");
    console.log('PASS native Goal resumes the same objective, revision and next task after a provider interruption and "继续"');
    console.log("PASS /goal logs shows the saved failed task and HTTP status without provider response text");
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}

async function compactBeforeNextTask(installed, { key = "early-compact", usage = 47_000, estimate, expected = true } = {}) {
  let scope, a;
  let working = false;
  const summary = "Stage A is complete. Continue at task two and verify both fixtures.";
  const actions = [
    readGoal,
    body => { scope = readScope(body); return planTasks(scope); },
    readGoal,
    () => alignTask(scope, 1),
    () => read("a.txt"),
    body => {
      const call = checkpoint(scope, "Verified A", [verified("A", "pass", body, "verified-a"), unverified[1]], 1);
      call.args.nextStageTokens = estimate;
      return { ...call, usage };
    },
    body => {
      assert.equal(JSON.stringify(body.messages).includes(summary), expected,
        "only compress when the next task needs more context and usage exceeds 70%");
      return readGoal();
    },
    body => {
      const after = JSON.parse(lastTool(body).text);
      assert.equal(after.goalId, scope.goalId);
      assert.equal(after.runId !== scope.runId, expected, "compaction resumes in a fresh Goal run");
      assert.equal(after.objective, goal.objective);
      assert.deepEqual(after.plan, { tasks, completed: 1 });
      scope = readScope(body);
      return alignTask(scope, 2);
    },
    () => write("b.txt", "verified-b"),
    () => read("a.txt"),
    body => { a = verified("A", "pass", body, "verified-a"); return read("b.txt"); },
    body => checkpoint(scope, "Verified both fixtures", [a, verified("B", "pass", body, "verified-b")]),
    () => ({ tool: "goalplus_complete", args: scope }),
    () => ({ text: "Both tasks verified." }),
  ];
  const server = await modelServer(body => {
    if (!toolNames(body).length) return { text: summary };
    if (!working) return { text: "Recorded the initial context." };
    const action = actions.shift();
    assert.ok(action, "unexpected continuation");
    return action(body);
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, key), installed.cli, installed.packages, server.baseUrl);
    await writeFile(join(fixture.cwd, "a.txt"), "verified-a");
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "Initialize the session. " + "Previous fixture notes. ".repeat(500) });
    await until(() => rpc.events.some(event => event.type === "agent_settled"), "initial native turn");
    working = true;
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/\[Complete\]/, /Task 2\/2/]);
    }, "Goal completion after proactive compaction");
    const entries = (await readFile(fixture.session, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.filter(entry => entry.type === "compaction").length, expected ? 1 : 0);
    if (expected) {
      await rpc.command("prompt", { message: "/goal logs" });
      const logs = await until(() => rpc.events.find(event => event.method === "notify" &&
        event.message?.startsWith("Goal logs")), "Goal compaction diagnostics");
      assert.match(logs.message, /Context compaction started.*early/);
      assert.match(logs.message, /Context compaction saved.*early/);
    }
    assert.equal(actions.length, 0);
    assert.equal(await readFile(join(fixture.cwd, "b.txt"), "utf8"), "verified-b");
    console.log(expected ? "PASS native Goal compacts above 70% before risky work and resumes the saved task" :
      `PASS native Goal skips proactive compaction at ${key}`);
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}

async function orderedTasks(installed) {
  let scope, a;
  const actions = [
    readGoal,
    body => { scope = readScope(body); return write("a.txt", "unplanned work"); },
    body => {
      assert.match(lastTool(body)?.text, /task plan/i, "work must wait for a plan");
      return planTasks(scope, [tasks[0], { title: "Repeat the first check", criteria: ["A"] }]);
    },
    body => {
      assert.match(lastTool(body)?.text, /cover every confirmed criterion/i);
      return planTasks(scope);
    },
    () => readGoal(),
    body => {
      assert.deepEqual(JSON.parse(lastTool(body).text).plan, { tasks, completed: 0 });
      return alignTask(scope, 2);
    },
    body => {
      assert.match(lastTool(body)?.text, /task 1/i, "steps cannot be skipped");
      return { tools: [alignTask(scope, 1), write("a.txt", "premature work")] };
    },
    body => {
      assert.match(lastTool(body)?.text, /align|goalplus_tasks/i, "alignment must be seen before work starts");
      return write("a.txt", "verified-a");
    },
    () => read("a.txt"),
    body => checkpoint(scope, "Verified A", [verified("A", "pass", body, "verified-a"), unverified[1]], 1),
    () => write("b.txt", "premature second task"),
    body => {
      assert.match(lastTool(body)?.text, /goalplus_read/i, "each new task must re-read the Goal");
      return readGoal();
    },
    body => {
      assert.equal(JSON.parse(lastTool(body).text).plan.completed, 1);
      return alignTask(scope, 2);
    },
    () => write("b.txt", "verified-b"),
    () => read("a.txt"),
    body => { a = verified("A", "pass", body, "verified-a"); return read("b.txt"); },
    body => checkpoint(scope, "Verified both fixtures", [a, verified("B", "pass", body, "verified-b")]),
    () => ({ tool: "goalplus_complete", args: scope }),
    body => {
      assert.match(lastTool(body)?.text, /completionProposed/);
      return { text: "Both fixture tasks finished successfully." };
    },
  ];
  const server = await modelServer(body => {
    const action = actions.shift();
    assert.ok(action, "Goal must stop once every task and criterion is verified");
    return action(body);
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "tasks"), installed.cli, installed.packages, server.baseUrl);
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    const done = await until(() => {
      server.assertHealthy();
      return strip(rpc, [/\[Complete\]/, /Task 2\/2/]);
    }, "completed Goal with task progress");
    assert.ok(strip(rpc, [/Task 1\/2/, /Fix and verify a\.txt/]));
    assert.ok(strip(rpc, [/\[Active\]/, /Task 2\/2/, /Fix b\.txt/]));
    assert.match(JSON.stringify(done), /2\/2 verified/);
    assert.equal(await readFile(join(fixture.cwd, "a.txt"), "utf8"), "verified-a");
    assert.equal(await readFile(join(fixture.cwd, "b.txt"), "utf8"), "verified-b");
    assert.equal(actions.length, 0);
    console.log("PASS native Goal task plan, per-task alignment, and 1/2 → 2/2 progress");
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}

async function longGoal(installed) {
  let scope, a, b;
  const seenRuns = new Set();
  const planned = [
    // First stage reports only prose after reading. This does not complete the Goal.
    () => read("a.txt"),
    body => {
      assert.equal(lastTool(body)?.name, "read");
      assert.match(lastTool(body).text, /goalplus_read|confirmed Goal/i);
      assert.doesNotMatch(lastTool(body).text, /verified-a/);
      return readGoal();
    },
    body => { open(body); return planTasks(scope); },
    () => ({ text: "I planned the fixture checks." }),
    readGoal,
    body => beginTask(body, 1),
    () => write("a.txt", "advance-before-audit"),
    body => {
      assert.equal(lastTool(body)?.name, "write");
      assert.match(lastTool(body).text, /audit|checkpoint/i);
      return read("a.txt");
    },
    body => checkpoint(scope, "Check A", [verified("A", "pass", body, "verified-a"), unverified[1]], 1),
    okayCheckpoint,
    // Later work breaks A. The broken work must not complete, even after A used to pass.
    readGoal, body => beginTask(body, 2),
    () => write("a.txt", "broken-a"),
    () => read("a.txt"),
    body => checkpoint(scope, "Detect regression", [verified("A", "fail", body, "broken-a"), { id: "B", state: "reopen" }]),
    body => { assert.equal(lastTool(body)?.name, "goalplus_checkpoint"); return { tool: "goalplus_complete", args: scope }; },
    body => {
      const verdict = lastTool(body);
      assert.equal(verdict?.name, "goalplus_complete");
      assert.match(verdict.text, /current|not|requires|cannot|fail/i);
      return { text: "Criterion A regressed and needs repair." };
    },
    readGoal, body => beginTask(body, 1),
    () => write("a.txt", "verified-a"),
    () => read("a.txt"),
    body => checkpoint(scope, "Repair A", [verified("A", "pass", body, "verified-a"), unverified[1]], 1),
    okayCheckpoint,
    readGoal, body => beginTask(body, 2),
    () => read("a.txt"),
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
  function beginTask(body, number) {
    open(body);
    return alignTask(scope, number);
  }
  let ready = false;
  const server = await modelServer(body => {
    if (!ready) {
      assert.ok(!toolNames(body).some(name => name.startsWith("goalplus_")));
      return { text: "Ordinary Pi Work" };
    }
    assert.ok(toolNames(body).includes("goalplus_read"));
    const goalCopies = body.messages.filter(message => message.role === "tool" &&
      String(message.content).includes('"objective":"Validate both GoalPlus fixtures"')).length;
    assert.ok(goalCopies <= 1, "historic Goal reads accumulated in provider context");
    const next = planned.shift();
    assert.ok(next, "an extra native request started after completion");
    return next(body);
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "long"), installed.cli, installed.packages, server.baseUrl);
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
    console.log("PASS native Pi RPC and local scripted provider: 4 automatic continuations, regression detected and repaired, Goal complete");
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
        return planTasks(scope);
      },
      readGoal,
      () => alignTask(scope, 1),
      () => read("a.txt"),
      body => checkpoint(scope, "Verified before compressing", [
        verified("A", "pass", body, "verified-a"), { id: "B", state: "reopen" },
      ], 1),
      readGoal,
      () => {
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
        const restored = JSON.parse(lastTool(body).text);
        assert.equal(restored.objective, goal.objective);
        assert.deepEqual(restored.plan, { tasks, completed: 1 });
        assert.ok(restored.evidence.some(item => item.criterionId === "A" && item.verdict === "pass"));
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
    const extensions = [];
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
    const fixture = await rpcFixture(join(scratch, key), installed.cli, installed.packages, server.baseUrl, extensions);
    await writeFile(join(fixture.cwd, "a.txt"), "verified-a");
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "Persist this native session. " + "Historical fixture content. ".repeat(400) });
    await until(() => rpc.events.some(event => event.type === "agent_settled"), "initial RPC settlement");
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/blocked/i, /awaits approval/i]) && stages.before.length === 0 &&
        rpc.events.filter(event => event.type === "agent_settled").length >= 2;
    }, "blocked Goal");
    const compaction = await rpc.command("compact", custom ? { customInstructions: "fixture-handoff" } : {});
    assert.match(compaction.summary, custom ? /separate extension/ : /native transcript/);
    assert.equal(sawCompaction, !custom);
    await rpc.close();
    rpc = undefined;
    stage = "after";
    rpc = fixture.launch();
    await rpc.command("get_state");
    await until(() => strip(rpc, [/Validate both/, /blocked/i, /Task 2\/2/]), "persisted Goal widget after restart");
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

async function interruptedDispatch(installed) {
  let entered = false;
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const server = await modelServer(async body => {
    if (!toolNames(body).includes("goalplus_read")) return { text: "Persist the ordinary session." };
    assert.equal(entered, false, "a second dispatch was issued for uncertain work");
    entered = true;
    await hold;
    return { text: "Original in-flight request released." };
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "interrupted"), installed.cli, installed.packages, server.baseUrl);
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "/goal " + goal.objective });
    await until(() => entered, "in-flight recorded Goal dispatch");
    assert.ok(!rpc.events.some(event => event.method === "editor" || event.method === "confirm"));
    await rpc.close("SIGKILL");
    rpc = undefined;
    release();
    rpc = fixture.launch();
    await rpc.command("get_state");
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/Validate both/, /blocked/i, /prior|previous|uncertain|interrupted/i]);
    }, "restored Goal with uncertain dispatch");
    assert.equal(rpc.events.some(event => event.type === "agent_start"), false);
    console.log("PASS first-run interruption: the confirmed Goal is durable before the first provider response and is not replayed");
  } finally {
    release();
    if (rpc) await rpc.close();
    await server.close();
  }
}

async function budgetLimit(installed) {
  let ownedRequests = 0;
  const server = await modelServer(body => {
    if (!toolNames(body).includes("goalplus_read")) return { text: "Ordinary Pi response." };
    ownedRequests++;
    assert.ok(ownedRequests <= 2, "Goal continued after reaching budget");
    if (ownedRequests === 1) return { ...readGoal(), usage: 100 };
    return { text: "Still unfinished." };
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "budget"), installed.cli, installed.packages, server.baseUrl);
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify({ ...goal, budgetTokens: 3 }) });
    await until(() => {
      server.assertHealthy();
      return strip(rpc, [/Validate both/, /budget exhausted/i]);
    }, "Goal budget exhausted");
    await until(() => rpc.events.some(event => event.type === "agent_settled"), "budget run settled");
    await rpc.command("get_state");
    server.assertHealthy();
    assert.ok(ownedRequests >= 1);
    console.log("PASS reported native token usage limits Goal updates separately from completion");
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}

async function parallelEvidence(installed) {
  let scope;
  const actions = [
    readGoal,
    body => {
      scope = readScope(body);
      return planTasks(scope);
    },
    readGoal,
    () => alignTask(scope, 1),
    () => {
      // The shell captures before-state, waits for the sibling to change it, then delivers a stale receipt.
      return { tools: [
        { tool: "bash", args: { command: "before=$(cat a.txt); touch sampled; for i in $(seq 1 100); do test -f changed && break; sleep 0.02; done; printf '%s' \"$before\"" } },
        { tool: "bash", args: { command: "for i in $(seq 1 100); do test -f sampled && break; sleep 0.02; done; printf 'changed-a' > a.txt; touch changed" } },
      ] };
    },
    body => {
      const stale = body.messages.findLast(message => message.role === "tool" && String(message.content).includes("verified-a"));
      assert.ok(stale, "the test must observe the read-before-write result");
      return checkpoint(scope, "Reject overlapping evidence", [
        { id: "A", state: "pass", source: stale.tool_call_id, observed: "The parallel check saw verified-a." },
        { id: "B", state: "reopen" },
      ]);
    },
    body => {
      const result = lastTool(body);
      assert.equal(result?.name, "goalplus_checkpoint");
      assert.match(result.text, /current|overlap|verification|receipt/i);
      assert.doesNotMatch(result.text, /"status":"audited"/);
      return { tool: "goalplus_block", args: {
        ...scope, reason: "Fixture awaits further verification", dependency: "user", evidence: "Parallel receipt was rejected",
      } };
    },
    () => ({ text: "Parallel verification must be repeated on current work." }),
  ];
  const server = await modelServer(body => {
    const action = actions.shift();
    assert.ok(action, "unexpected parallel evidence request");
    return action(body);
  });
  let rpc;
  try {
    const fixture = await rpcFixture(join(scratch, "parallel"), installed.cli, installed.packages, server.baseUrl);
    await writeFile(join(fixture.cwd, "a.txt"), "verified-a");
    rpc = fixture.launch();
    await rpc.command("prompt", { message: "/goal start " + JSON.stringify(goal) });
    await until(() => {
      server.assertHealthy();
      return actions.length === 0 && rpc.events.some(event => event.type === "agent_settled");
    }, "parallel evidence handled");
    assert.equal(await readFile(join(fixture.cwd, "a.txt"), "utf8"), "changed-a");
    assert.ok(!strip(rpc, [/\[Complete\]/]));
    console.log("PASS native parallel tool results cannot satisfy acceptance with a stale observation");
  } finally {
    if (rpc) await rpc.close();
    await server.close();
  }
}
