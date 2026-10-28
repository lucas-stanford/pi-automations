---
name: issue-triage
description: Triage the next unlabelled issue in github.com/example/app, reproduce it when that is safe, draft a label and a reply, and record progress on its flowchart.
timeout: 60m
on:
  manual: true
hooks:
  pre:
    - script: scripts/pick_issue.js
  post:
    - script: scripts/save_report.js
---

Goal: answer one question honestly — **is this issue real, and who should look at it?**

## Safety rules

- Never change labels or post replies outside `config.json`'s repository.
- `needs-info` is a valid result; do not invent a stronger verdict.

## Common commands

```bash
node draft.js --issue <N>
pa next reproduce --from read -m "Trying it on staging"
```
