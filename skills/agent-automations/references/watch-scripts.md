# Watch scripts

`on.watch` runs a script every `every` without a model. A run starts only when the script reports something new, so an hour with no new work costs no model calls.

```yaml
on:
  watch:
    script: scripts/watch.mjs   # relative to the automation folder, inside it
    every: 5m                   # 1m to 24h
  manual: true
```

## Contents

- [The contract](#the-contract)
- [What to print](#what-to-print)
- [When checks run](#when-checks-run)
- [After a run starts](#after-a-run-starts)
- [Template](#template)
- [Testing](#testing)

## The contract

| The script | The host |
|---|---|
| Exits `0` and prints something different from what started the last run | Starts a run and remembers a fingerprint of the output. |
| Exits `0` and prints the same as what started the last run | Does nothing. |
| Exits with any other code (use `3` for "nothing to do") | Does nothing and forgets the last finding. |
| Times out, cannot start, or is killed by a signal | Does nothing and keeps the last finding. |

- The fingerprint is a SHA-256 of standard output with surrounding whitespace trimmed.
- The output is **not** passed to the run. Use a pre hook to fetch the details the body needs.
- The first line of standard output (on exit `0`) or the last line of standard error (otherwise) is shown in listings as what the check said, clipped to 200 characters. Write a short reason on stderr when exiting `3`.

## What to print

Print one stable identifier per line, sorted: URLs, ids, file names. Never print timestamps, counters, "checked at …" or anything else that changes when nothing has changed, or every check starts a run.

Print only what still needs doing. When the body handles an item, the item should disappear from the output (closed, labelled, moved), so the next check sees a change, or nothing.

## When checks run

- The host ticks once a minute; a check is due when `every` has passed since the last one.
- No check runs while a run of the same automation is going, while the host has paused the watch, or while the automation is not armed (invalid, disabled, or not armed yet).
- A check may take at most the host's hook timeout, capped at 2 minutes.
- The script starts in the automation folder, with no stdin, the `AUTOMATION_*` variables (`AUTOMATION_PHASE=watch`, `AUTOMATION_TRIGGER=watch`) and no credential-shaped variables. `AUTOMATION_LAST_CHECKED` is the ISO time of the previous check that ran to an exit code, for "what changed since".
- Scheduled checks do not read the shell profile. Use tools that keep their own login.

## After a run starts

The host remembers the finding that started a run, whatever the run's outcome. If the run failed or was skipped and the script keeps printing the same thing, no new run starts. This keeps a broken run from being retried every five minutes. To retry, run it by hand, or let the output change.

The host keeps the fingerprint, so most watch scripts need no state of their own. A script that does keep state must survive being killed halfway and run again.

Any non-zero exit forgets the finding, including an exit caused by a network error. After one, the next successful check counts as new even if it prints the same items, and a run starts. Write the body so a second run over the same items does no harm.

## Template

```js
// scripts/watch.mjs: prints one line per open item, or exits 3 when there is none.
import { execFileSync } from "node:child_process";

let items;
try {
  const out = execFileSync("gh", ["search", "prs", "--review-requested=@me", "--state=open", "--json", "url"], {
    encoding: "utf8",
  });
  items = JSON.parse(out).map((pr) => pr.url).sort();
} catch (e) {
  console.error(`could not ask GitHub: ${e.message.split("\n")[0]}`);
  process.exit(1); // no run now, but the last finding is forgotten
}

if (items.length === 0) {
  console.error("no review requests");
  process.exit(3);
}
console.log(items.join("\n"));
```

Pair it with a pre hook that fetches the details for the same items, and a body that handles each one and skips any it already handled.

## Testing

- If the host can run one watch check without starting a run, use that: it says whether a tick would start a run, and starts and records nothing.
- Run the script directly from the automation folder: `node scripts/watch.mjs; echo $?`. Run it again without changing anything: the output must be the same.
