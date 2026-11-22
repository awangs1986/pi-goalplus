# Pi GoalPlus

Give Pi an objective, constraints, and verifiable criteria. GoalPlus keeps the
objective visible, continues after settled turns, and requires current
evidence before finishing. It runs in the existing Pi session and workspace.

## Install

Use Node.js 22.19 or newer and a supported Pi version. Pi 1.6.0 is the primary
target. Install from the GitHub repository with Pi's native package manager:

```sh
pi install git:github.com/awangs1986/pi-goalplus
```

To try a checkout, run `npm ci` in it, then `pi -e ./src/index.ts`. Reload or
restart Pi after installing. Use a single extension that owns the `/goal`
command per session.

## Use

Type `/goal Keep the migration compatible with existing consumers`. Review the
editable objective, constraints and criteria and confirm Start. Pi will use
your current model and start the first turn. The Goal widget above the editor
shows the objective, current stage, status and acceptance progress.

| Command | Action |
| --- | --- |
| `/goal` or `/goal status` | Show the saved requirements and current progress. |
| `/goal <objective>` | Draft and confirm a Goal in a dialog-capable session. |
| `/goal start <JSON>` | Start an explicitly approved structured Goal from a client without a dialog. |
| `/goal edit` or `/goal edit <JSON>` | Confirm or explicitly submit a new revision of the saved requirements. |
| `/goal pause` | Let the current run settle and pause new Goal turns. |
| `/goal stop` | Pause the Goal and cancel its current run through Pi. |
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

## Evidence and compaction

Goal turns read the confirmed requirements before using tools. A stage
checkpoint accounts for every criterion and records native tool receipts that
support the verdicts. A completion proposal is tied to the current confirmed
revision and run. Later changes can invalidate evidence, and Pi must settle
successfully before completion is final.

Native Pi owns compaction. GoalPlus keeps the Goal in separate native session
entries, so the next turn retrieves the same confirmed requirements even if
prior model context was condensed. Tool results remain in Pi's native history.
The extension checks receipt identity and coverage. The model still judges
whether the observed evidence is relevant and sufficient.

## Develop

```sh
npm ci
npm run check
```

The native tests install a packed copy with an official Pi release and use an
isolated session and scripted local provider. See the [specification](docs/spec.md).
