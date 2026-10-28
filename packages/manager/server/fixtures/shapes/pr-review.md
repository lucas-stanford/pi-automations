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
Return the review link, or a short reason why there is none, then end the run.
