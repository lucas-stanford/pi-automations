# Review checklist

Use this before handing an automation to the user, and when asked to review one.

## File and folder

- [ ] The folder is `~/.agents/automations/<name>/` (user scope) or `<repo>/.agents/automations/<name>/` (repository scope).
- [ ] `AUTOMATION.md` starts with `---` on the first line and has a second `---` line.
- [ ] `name` equals the folder name: lowercase letters, digits, single hyphens, at most 64 characters.
- [ ] Only these top-level fields: `name`, `description`, `enabled`, `model`, `timeout`, `on`, `hooks`, `flow`.
- [ ] `description` is one plain sentence, at most 1024 characters, saying what and when.
- [ ] The body after the closing `---` is not empty.

## Triggers

- [ ] `on` has at least one of `schedule`, `watch`, `manual`, and nothing else.
- [ ] `manual: true` is present unless manual runs must be impossible. Never `manual: false`.
- [ ] Every cron is quoted, has five fields, and uses only `*`, values, ranges, lists and steps.
- [ ] A schedule in a repository names a `timezone` (an IANA name such as `Europe/London`).
- [ ] `catch-up: once` only when a late run is still useful; the body handles `late="true"`.
- [ ] `on.watch` has both `script` and `every`, and `every` is between `1m` and `24h`.

## Hooks and scripts

- [ ] Each hook item has exactly one key: `script` or `prompt`.
- [ ] Every script path is relative, stays in the folder, and the file exists.
- [ ] Scripts are `.mjs` unless every machine has the interpreter. No extension only on macOS or Linux, with `chmod +x`.
- [ ] Pre hook scripts exit non-zero (by convention `3`) with a one-line stderr reason when there is nothing to do.
- [ ] Pre hooks only read. Writes happen in the body or in post hooks.
- [ ] Scripts need no credentials from environment variables: they are removed, and scheduled runs do not read the shell profile.
- [ ] Each script finishes well inside the host's hook timeout (watch scripts at most 2m).
- [ ] A watch script prints stable identifiers only, exits `0` only when there is work, and does not print timestamps.

## Body

- [ ] Written as numbered steps: what to read, what to do, what to produce, when to stop.
- [ ] Reads facts from the input block rather than fetching them again.
- [ ] Safe to run twice: checks before acting, updates in place, uses stable identifiers.
- [ ] Any destructive or outward-facing action has an explicit guard or limit, and the user asked for it.
- [ ] Asks, in plain words and without naming a tool, for a record of each thing it publishes, with its link.
- [ ] Ends by asking for one short message for the reader: what happened, what needs them, with links to what they will open next.
- [ ] A flowchart, if any, is the first `mermaid` block, uses `pre0`/`body`/`post0` for the hooks and body, and has no separate `flow.mmd`.
- [ ] A chart with more than two steps, a branch or a retry has `flow: strict`.
- [ ] With `flow: strict`: one `## <label> {#id}` section per step, headings equal to the labels, in the chart's order, no other `##` headings, and every branching step names each step it can go to, by id or label ("go to `fix`").
- [ ] Long reference material lives in a skill the body names, not in the body.

## Limits

- [ ] `timeout` is set a little above the slowest normal run, in `s`, `m` or `h`, at most the host maximum.
- [ ] `model` is left out, or names a model that is available, as `<provider>/<id>[:<thinking>]`.

## Tried

- [ ] The host's checker, if it has one, finds no problem.
- [ ] The user saw what the host will run and armed it themselves. Any later edit turns it off until they arm it again.
- [ ] A run by hand ended `ok`, and its record shows the expected answer, what it published and its message.
- [ ] For a watch, one watch check behaves as expected with and without work.
- [ ] If it has a schedule or a watch, the host fires them while nobody is at the keyboard.
