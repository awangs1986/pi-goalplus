# Persistent Goals in standalone Pi

GoalPlus lets a user give the Pi coding agent a durable objective and have it
continue to a verified result. It uses the current Pi session, workspace,
provider, tools and approvals. It can be installed in an ordinary Pi setup.

## Start and control a Goal

Submitting `/goal <objective>` authorizes immediate start and sets the original
objective. GoalPlus derives an acceptance criterion from that objective. The
user can submit structured requirements, including constraints, criteria and
an optional token budget, through `/goal start <JSON>`. Plain prompts leave Goal
creation to the explicit command. Only user commands can revise or clear the
confirmed requirements. A revision resets the plan and reopens acceptance.

A session has at most one current Goal per selected history branch. Persist the
confirmed requirements, task plan, progress, evidence and dispatch state in
native session entries. The Pi widget shows the objective, stage, status,
acceptance progress and current task number over the total. RPC clients can
display the native extension UI events. Status details must remain readable
after reload and resume. Selection changes must never substitute another
history branch's Goal.

Pause prevents additional turns and allows the in-flight turn to settle. Stop
persists the pause before requesting native cancellation. Resume uses the
previous requirements and evidence. Clear retires the Goal and keeps the
conversation and project files.

## Automatic continuation

Start the first Goal turn in the existing Pi session. When native retries,
compaction and the native queue have settled, continue an active Goal with at
most one eligible turn. Normal user input takes priority. Every dispatch
belongs to one Goal revision and uses the same native Pi tools and permissions
as a normal turn. Normal progress has no fixed round limit. A model response,
a stage boundary and successful compaction leave the Goal active.

Retry safely recoverable runtime failures with backoff. Repeated lack of useful
activity calls for a different approach before diagnosing a blocker. An active
Goal can become paused, blocked, limited by provider usage, limited by an
explicit token budget, or complete. Report the reason and restore previous
requirements when the user resumes. Never automatically repeat a dispatch with
an uncertain outcome. A settled Goal can resume safely from its saved history. A freshly confirmed
Goal and its first dispatch must be saved by the first provider request. One
live Pi process owns any given native session.
Token limits are evaluated from reported usage at execution boundaries. A
provider call already in progress can use more tokens before usage is known.

## Stage and final audits

Each Goal turn reads the confirmed revision. Before changing the project,
save an ordered plan of 2–24 tasks that covers every acceptance criterion.
Preserve the user's steps if supplied. Pi can inspect requirements using
native read-only tools while planning. The plan may keep completed tasks and
revise pending ones as work reveals new facts.

Before starting or resuming a task, Pi compares it with the original objective,
constraints and criteria and submits an alignment rationale. GoalPlus waits for
the model to receive that result before allowing task work. After planning,
advancing a task, compaction, or user steering, Pi reads the requirements again
and aligns the current task. Reopening an earlier task for repair also reopens
the later tasks.

Checkpoint each completed task against every criterion and constraint, verify
affected items, and reopen those with failed or unclear evidence. Record a
short stage, evidence references and current verdicts. The final task finishes
with Goal completion after the final audit and successful settlement.

A completion proposal must refer to the active Goal, its confirmed revision
and the current run. It must include current acceptance coverage and passing
evidence for every required item, with all constraints checked. Reject missing
or stale coverage. The runtime finalizes completion only after successful
settlement. Model judgment about evidence does not establish factual validity
by itself. Prefer runnable checks and concrete results.

Native Pi compaction and optional Handoff keep their own compaction policies.
The next Goal work reads the stored revision and evidence again. Repeated
rounds need short context and receipt pointers. Older Goal reads appear only
as references in model requests; their full original results stay in native
Pi history.

## Acceptance

| Scenario | Expected behavior |
| --- | --- |
| Explicit start and view | Submitting `/goal <objective>` immediately starts one turn. Ordinary prompts leave Goal creation to the command. |
| Plan and task progress | Work begins with an ordered plan. Each task is aligned to the original requirements before execution. The widget shows `Task 1/2` and advances to `Task 2/2` at the next task. |
| Long task | A task requiring more than three autonomous turns continues without another user message until final acceptance. |
| Regression | A previously passing criterion goes stale or fails after a later operation. Completion is rejected until that item is reverified. |
| Compaction | Native compression preserves the Goal and task plan. Resumed work rereads the original requirements and current evidence before aligning the task. |
| Recovery | On pause, stop, resume and reopen, Goal state follows the active session branch. Uncertain work is not silently repeated. |
| Limits | Provider limits and explicitly configured token budgets display the cause. Goal completion is independent of both. |

Use the published Pi extension and RPC seams for deterministic tests. Live model
assessment of whether an agent selects the right checks and detects semantic
drift is separate.

Source references: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[Pi Agent Goal](https://github.com/KristjanPikhof/Pi-Agent-Goal), and
[Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).
