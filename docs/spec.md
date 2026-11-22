# Persistent Goals in standalone Pi

GoalPlus lets a user give the Pi coding agent a durable objective and have it
continue to a verified result. It uses the current Pi session, workspace,
provider, tools and approvals. It can be installed in an ordinary Pi setup.

## Start and control a Goal

A Goal starts only after explicit confirmation of its objective, constraints
and acceptance criteria. The user can draft those in Pi, or bring requirements
from a PRD. Plain prompts never start a Goal. Only user commands can revise or
clear the confirmed requirements. A revision reopens any criteria it may affect.

A session has at most one current Goal per selected history branch. Persist the
confirmed requirements, latest progress, evidence and dispatch state in native
session entries outside the model's working context. The default Pi widget
shows the objective, stage, current status and passed/total. RPC clients can
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
an uncertain outcome. A settled Goal can resume safely from its saved history.
Token limits are evaluated from reported usage at execution boundaries. A
provider call already in progress can use more tokens before usage is known.

## Stage and final audits

Each started Goal turn reads the confirmed revision before taking other
actions. At the end of a stage and before advancing, review every criterion and
constraint and verify affected items. Reopen any that fail or have unclear
evidence after later changes. Record a short stage and next item, evidence
references and current verdicts. The maintenance of a progress note alone
does not constitute progress.

A completion proposal must refer to the active Goal, its confirmed revision
and the current run. It must include current acceptance coverage and passing
evidence for every required item, with all constraints checked. Reject missing
or stale coverage. The runtime finalizes completion only after successful
settlement. Model judgment about evidence does not establish factual validity
by itself. Prefer runnable checks and concrete results.

Native Pi compaction and optional Handoff keep their own compaction policies.
The next Goal work reads the stored revision and evidence again. Repeated
rounds need short context and receipt pointers; full tool outputs live in
native Pi history.

## Acceptance

| Scenario | Expected behavior |
| --- | --- |
| Explicit start and view | A confirmed Goal starts one turn. Native UI shows objective, stage and progress. Ordinary prompts never create a Goal. |
| Long task | A task requiring more than three autonomous turns continues without another user message until final acceptance. |
| Regression | A previously passing criterion goes stale or fails after a later operation. Completion is rejected until that item is reverified. |
| Compaction | Native compression preserves the durable goal; resumed work re-reads the original requirements and current evidence before taking action. |
| Recovery | On pause, stop, resume and reopen, Goal state follows the active session branch. Uncertain work is not silently repeated. |
| Limits | Provider limits and explicitly configured token budgets display the cause. Goal completion is independent of both. |

Use the published Pi extension and RPC seams for deterministic tests. Live model
assessment of whether an agent selects the right checks and detects semantic
drift is separate.

Source references: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[Pi Agent Goal](https://github.com/KristjanPikhof/Pi-Agent-Goal), and
[Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).
