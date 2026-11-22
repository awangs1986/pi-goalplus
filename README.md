# Pi GoalPlus

Give Pi an objective, constraints, and verifiable criteria. GoalPlus keeps the
objective visible, continues after settled turns, and requires current
evidence before finishing. It runs in the existing Pi session and workspace.

## Install

Use Node.js 22.19 or newer. The supported Pi lines are 1.6.x and 1.4.x.
The native package checks use Pi 1.6.0 and 1.4.0. Install from the GitHub repository with Pi's native package manager:

```sh
pi install git:github.com/awangs1986/pi-goalplus
```

To try a checkout, run `npm ci` in it, then `pi -e ./src/index.ts`. Reload or
restart Pi after installing. Use a single extension that owns the `/goal`
command per session.

## Use

Submit `/goal Keep the migration compatible with existing consumers` to start
immediately with your current model. Use `/goal start <JSON>` when you want to
specify acceptance criteria, constraints, or a token budget up front.

GoalPlus saves an ordered task plan before making project changes. Pi reuses
steps you provide, or splits the objective into concrete tasks. Before each
task, Pi reads the original requirements and explains how the task advances the
objective and respects its constraints. The widget shows the current task as
`Task 2/5`, alongside the objective and acceptance progress. The plan and
progress survive compaction and session reopen.

| Command | Action |
| --- | --- |
| `/goal` or `/goal status` | Show the saved requirements and current progress. |
| `/goal <objective>` | Start a Goal immediately with the given objective. |
| `/goal start <JSON>` | Start an explicitly approved structured Goal from a client without a dialog. |
| `/goal edit` or `/goal edit <JSON>` | Confirm or explicitly submit a new revision of the saved requirements. |
| `/goal pause` | Let the current run settle and pause new Goal turns. |
| `/goal stop` | Pause the Goal and cancel its current Pi run or proactive compaction. |
| `/goal resume` | Continue the saved Goal when eligible. |
| `/goal clear` | Clear the Goal while keeping native conversation history and workspace files. |

An approved JSON definition has an `objective`, `constraints`, and a nonempty
`criteria` array. Give each criterion its own ID and verification method. An
optional positive integer `budgetTokens` applies to the Goal's cumulative
usage.

```text
/goal start {"objective":"Fix the build","constraints":["Keep the public API stable"],"criteria":[{"id":"build","requirement":"The project builds","verification":"Run npm run build"}]}
```

For automation use Pi's interactive or RPC session so it can keep processing
successive runs. RPC clients receive the standard `setWidget` and `notify`
extension UI frames. Record which native Pi session to reopen if you stop the
process. A Goal can continue when Pi can confirm the previous work settled.
An uncertain in-flight run needs review before you explicitly resume it.
Use one live Pi process per session. Third-party asynchronous work that returns
control to Pi before it finishes needs its own completion signal or a paused
Goal.

## Evidence and compaction

Goal turns read the confirmed requirements before using tools. A checkpoint
accounts for every criterion and constraint and records native tool receipts
that support the verdicts. Pi can reopen earlier tasks for repairs. The final
task finishes once the current revision passes its acceptance audit and the
native run settles successfully.

When context usage exceeds 70% and the remaining space looks too small for
the next stage, GoalPlus saves the checkpoint and requests native Pi
compaction before continuing. The forecast uses recent context growth or an
estimate supplied at the checkpoint, with room for at least one model
response. The next turn rereads the saved requirements and task progress.
Reported compaction tokens count toward the Goal budget. Tool results remain
available in Pi's native history.
Arbitrary shell and other potentially mutating tools make previous workspace
evidence stale. For several shell verifications, run them together and capture
each outcome in one result, then add read-only checks as needed. Final
acceptance uses current-run receipts. The extension validates receipt identity
and criterion coverage. The model judges whether the evidence is relevant and
sufficient.

## Develop

```sh
npm ci
npm run check
```

The native tests install a packed copy with an official Pi release and use an
isolated session and scripted local provider. See the [specification](docs/spec.md).
