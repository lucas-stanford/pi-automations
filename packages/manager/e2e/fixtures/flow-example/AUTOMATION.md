---
name: flow-example
description: A manual example that fans status-note work out to subagents and tracks the branches on its flowchart.
timeout: 5m
on:
  manual: true
hooks:
  pre:
    - script: scripts/start_flow.js
  post:
    - script: scripts/finish_flow.js
---

This is a real parallel-subagent demonstration. You must call `subagent` once with
`agentScope: "user"` and `tasks: [{ agent: "worker", task: "..." }, { agent: "worker", task: "..." }]`.
Do not use single/chain mode, simulate workers, or silently fall back to doing their work yourself.

Give each worker the current run metadata from the input below; subagents do not share your context.
Use the current working directory for both tasks. Include these instructions in their task strings:

1. **Outline worker**: First run `node scripts/report_flow.js outline active "Drafting outline"`.
   Draft a terse outline with Run details, Work completed, and Save status sections (under 80 words).
   Then run `node scripts/report_flow.js outline done "Outline ready"` and return the outline.
2. **Facts worker**: First run `node scripts/report_flow.js facts active "Checking run facts"`.
   Extract only the supplied automation name, trigger, run id and timestamp
   into a short list. Do not look at prior runs or files. Then run
   `node scripts/report_flow.js facts done "Run facts checked"` and return the list.

Tell BOTH workers: do not write files, delegate further, report on another worker's node, or claim that
post-hooks have already finished. Only the reporting commands and a concise text reply are needed.
The reporting helper inherits `AUTOMATION_RUN` and `AUTOMATION_NODE`, reports with `pa`, and
is best effort when `pa` is unavailable. Do not modify these scripts or repair configuration mid-run.

Wait for both results and check they succeeded. On a worker failure, mark its node `failed` with
the same helper and return a brief failure report with the actual error. If the tool is absent,
report that explicitly. Do not label a failed delegation as a successful demonstration.

After both workers succeed, run `node scripts/report_flow.js compose active "Combining worker results"`.
Combine their replies into a short Markdown status note, then run
`node scripts/report_flow.js compose done "Status note ready for post-hook"`.

Your final reply must be ONLY the Markdown note (not a code fence or a description of a file).
Include the run metadata and state that both workers completed and the note is ready to save.
Do not write any files yourself: the post-hook saves this final reply as `STATUS_NOTE.md` and
`output/latest.md`. Do not claim the post-hook has already run.
