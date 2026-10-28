---
name: daily-digest
description: Summarize yesterday's activity in the example/app repository into a short morning digest.
timeout: 10m
on:
  schedule:
    cron: "0 8 * * MON-FRI"
    catch-up: once
  manual: true
hooks:
  pre:
    - script: scripts/fetch_activity.js
  post:
    - script: scripts/save_digest.js
---

# Daily digest

Use the activity snapshot above to write a concise morning digest.

Please include:
- a one-paragraph overview of what changed
- the 3 most important items to look at today
- anything stale or blocked
- anything merged or closed in the last day
- a short list of suggested next steps

Ground the digest only in the supplied data. If nothing happened, say so plainly.
