---
name: pr-review
description: Review one open pull request in github.com/example/app per run, and save the review before publishing it.
enabled: true
model: anthropic/claude-sonnet-4-5:high
timeout: 120m
on:
  manual: true
---

Read `RUNBOOK.md` completely and follow it. Read `config.json` for the repository and the review scope.

Handle **at most ONE pull request and publish at most ONE review** in this run.
Choose once; review, skip or block that pull request, then stop. Never pick a second one.

Use `scripts/tracking.js` to claim the pull request, save the review and record that it was
published. Reuse a saved review instead of reviewing again. Leave other people's claims alone.
The helper is the only thing that publishes; do not retry its request by hand.

Return the review link, or a short reason why there is none, then end the run.
