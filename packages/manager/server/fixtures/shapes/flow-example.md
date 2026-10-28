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

This is a parallel-subagent demonstration. Call `subagent` once with
`tasks: [{ agent: "worker", task: "..." }, { agent: "worker", task: "..." }]`.

1. **Outline worker**: run `node scripts/report_flow.js outline active "Drafting outline"`.
2. **Facts worker**: run `node scripts/report_flow.js facts active "Checking run facts"`.

Your final reply must be ONLY the Markdown note (not a code fence).
