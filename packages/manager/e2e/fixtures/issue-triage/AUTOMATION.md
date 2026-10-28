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

The pre-hook picks the issue and the post-hook saves the report. During the run, report progress
with `pa step` at the major milestones.

## Safety rules

- Never change labels or post replies outside `config.json`'s repository.
- Never run `reply.js --send` unless the user explicitly asks for it.
- `needs-info` is a valid result; do not invent a stronger verdict.
- Only try a reproduction against https://staging.example.com, never production.

## Milestones

- `read` — issue and its thread read
- `reproduce` — reproduction attempted, when it is safe and useful
- `draft` — label and reply drafted

Suggested transitions:

```bash
pa step read --done "Read the issue and its thread"
pa next reproduce --from read -m "Trying it on staging"
```

## Workflow

1. Read the issue the pre-hook picked, and its comments.
2. Decide whether a reproduction is useful and safe; if so, try it on staging.
3. Draft a label and a short reply with `node draft.js --issue <N>`.
4. Preview the reply with `node reply.js --issue <N>` without `--send`.
5. Output a final Markdown report. The post-hook saves it to `output/latest.md`.

## The report should include

- the issue and why it was picked
- what was checked, and what was found
- the suggested label and reply
- the issue link on the last line

## Common commands

```bash
node draft.js --issue <N>
node reply.js --issue <N>
pa note "Drafted a reply" --link "issue=https://github.com/example/app/issues/<N>"
```
