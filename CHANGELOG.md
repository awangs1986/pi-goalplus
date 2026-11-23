# Changelog

## 0.4.1

- Route a legacy `checkpoint` call to `goalplus_checkpoint` during an active
  Goal when the short name is unclaimed.
- Report missing Goal controls and the Coffee Work requirement before sending
  a Goal turn to the provider.

## 0.4.0

- Add `/goal logs [count]` for recent Goal diagnostics in the native Pi session.
- Record run failures, task transitions, tool failures, compaction and recovery
  with bounded diagnostic metadata.

## 0.3.1

- Route standalone continuation requests such as `继续` and `continue` to
  Goal resumption. Resume from the original objective and saved task after
  interruptions.

## 0.3.0

- Request native Pi compaction before the next Goal stage when context usage
  exceeds 70% and the expected work reaches the remaining capacity.
- Resume the saved task after compaction and include reported summary usage in
  the Goal token budget.

## 0.2.0

- Start a Goal as soon as the user submits `/goal <objective>`.
- Plan ordered tasks, check each task against the original requirements before
  work, and show the current task number and total in the Goal widget.

## 0.1.1

- Make the default interactive Goal draft valid and let users correct invalid
  drafts in the editor without losing their changes.

## 0.1.0

- Add a standalone native Pi Goal with confirmed requirements, persistent status,
  evidence checks, automatic continuation, and native pause/resume controls.
