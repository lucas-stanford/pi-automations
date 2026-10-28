# Plugins

pi-automations runs, tracks and edits automations without plugins. A plugin can observe runs, add
actions or draw flowcharts. It loads only from the person's own config, never from a repository or
an automation, because it runs with your permissions in every pi session, every run and every `pa`
command. Only you decide where it comes from.

```jsonc
// ~/.pi/agent/pi-automations/config.json
{ "plugins": ["manager", "~/pa-plugins/slack-notes.mjs"] }
```

| Entry | Loads |
|---|---|
| `manager` | the Automation Manager, built into this package: `packages/manager/plugin/index.js` |
| an absolute or `~/` path | that module; a directory means its `index.js` |

A relative path, or anything else, is a config warning and is skipped. Entries load in order.

## Where a plugin runs

| `api.where` | Process | What is asked of it |
|---|---|---|
| `host` | pi, with this extension loaded | actions in `/automations`, the renderer, observers |
| `worker` | the process that runs one automation (`bin/fire.js`) | observers only |
| `cli` | `pa` in a shell: `pa edit`, `pa <action>`, `pa help` | actions |

`pa list`, `pa run` and the other built-in verbs do not load plugins, so they stay quick. A worker
loads plugins before the run starts. Loading has a time limit like every other call, so a broken
plugin costs a run at most a few seconds and a line on its record.

## The module

```js
/** @type {import("pi-automations/dist/plugins/types.js").PiAutomationsPlugin} */
export default {
  name: "slack-notes",
  setup(api) {
    if (api.where === "cli") return;
    api.on("note", async ({ run, note }) => post(`${run.name}: ${note.text}`));
    api.on("run-end", async ({ run, record }) => {
      if (record.outcome === "failed") await post(`${run.name} failed: ${record.error?.message}`);
    });
  },
};
```

The default export is `{ name, setup(api) }`, or the `setup` function alone. A plugin imports only
this package's types (`dist/plugins/types.d.ts`, from `src/plugins/types.ts`). At run time it is
handed everything it uses, so it always runs against the pi-automations that loaded it.

## The API

```ts
interface PluginApi {
  apiVersion: 1;
  where: "host" | "worker" | "cli";
  entry: string;                         // the config entry it was loaded from
  host: HostServices;                    // built on first use
  on(event, handler): void;              // "run-start" | "step" | "note" | "message" | "run-end" | "shutdown"
  addAction(action: PluginAction): void;
  setRenderer(render: PluginRenderer): void;
  warn(message: string): void;           // shown the way a load failure is
}
```

### Observing runs

| Event | Payload | When |
|---|---|---|
| `run-start` | `{ run, startedAt }` | the run is going ahead: its lock is held, its model resolved, its workspace ready |
| `step` | `{ run, step }` | a node of its flowchart moved or got a new update; `step` is the node now (`id`, `label`, `status`, `text`) |
| `note` | `{ run, note }` | a note was left (`pa note "…" --link "label=https://…"`): `ts`, Markdown `text`, `links` |
| `message` | `{ run, message }` | the run left its message for the reader, or replaced it (`pa message "…" --link …`): the message as it is now, shaped like a note |
| `run-end` | `{ run, record }` | the record is written. Also for a run that ended before it started (skipped, refused): those have no `run-start` |
| `shutdown` | — | the loading process is letting the plugin go (pi's session ended, `pa edit` got Ctrl+C) |

`run` is `{ runId, key, name, scope, trigger }`. Whoever reports a step or note (the run, its
hooks, subagents) writes it into the run's progress file. The worker reads that file twice a second
while the run goes, and once more at its end, so a node that moved twice between two reads is
reported once, as it is now. Observers hear about events after they happen: nothing they return or
throw changes the run.

### Actions

```ts
interface PluginAction {
  id: string;            // [a-z][a-z0-9-]*, also the pa verb; "edit" takes over e and pa edit
  label: string;         // the /automations menu entry
  description?: string;  // one sentence under the menu
  key?: string;          // a free single key in the list (built-in keys win)
  run(ctx: { automation?: ActionTarget; where; open: boolean }):
    void | { message?: string; url?: string; keepAlive?: boolean } | Promise<…>;
}
```

`ActionTarget` is `{ key, name, scope, dir, file }`. `open` is false for `pa <action> --no-open`.
`keepAlive: true` says the action is serving from this process (a local server). `pa` then stays in
the foreground until Ctrl+C, and calls `shutdown` before it exits. An action cannot take a built-in
verb (`run`, `list`, …), and the second plugin to add an id is refused.

Without a plugin that adds `edit`, `e` and `pa edit` open `AUTOMATION.md` in your editor. From a
shell that is `$VISUAL`, then `$EDITOR`, then VS Code, then the system opener. Inside pi it is VS Code
or the system opener, because a terminal editor would fight pi for the screen.

### Drawing flowcharts

```ts
type PluginRenderer = (req: {
  chart: string;                                        // the run's Mermaid flowchart
  state: { nodes: Record<string, string>; taken: [string, string][] };
  format: "text" | "svg";
  timeoutMs: number;
}) => { text: string } | { problem: string };
```

The first plugin to set a renderer draws instead of fm. Rendering is synchronous, because the
terminal is waiting for a frame. A renderer that takes longer than `timeoutMs` is reported and not
asked again in that pi session. When one throws or answers `problem`, that flowchart falls back to
fm, then to the step list.

## Host services

`api.host` is pi-automations' own code, handed over so a plugin never keeps a second copy of its
rules. Every write checks what is on disk first and goes through pi-automations' parser, the same
way a run reads the file. Writes to one automation are queued.

| | |
|---|---|
| `index()` | every automation, grouped by root as `/automations` groups them |
| `bundle(key)` | one automation: its documents with revisions, parsed fields, problems in pi-automations' words, next scheduled times, its last twenty runs (with steps, notes and message) |
| `validate(text, name)` | parse an `AUTOMATION.md` as pi-automations would, without touching disk |
| `compose(key, draft)` | what a save of this draft would write, and what is wrong with it |
| `save(key, request)` | write it; refuses with `conflict` if the files moved since `base`, `invalid` if it does not parse (unless `allowInvalid`) |
| `listFiles` · `readFile` · `writeFile(key, path, …)` | text files in the automation folder; links, `..`, device names and the two validated documents are refused |
| `runs(key, limit?)` | its run records, newest first |
| `history({ key?, outcome?, withMessage?, limit? })` | every listed automation's runs as run summaries with their `key` and `name`, newest first; `withMessage` keeps runs that left a message or notes; at most `limit` (200 by default) |
| `progress(runId)` | a running run's flowchart, steps, arrows taken, notes and message; undefined once it has ended |
| `models()` | pi's enabled and available models, and the ones automations name |

A refusal is an `Error` with a `code` (`bad-request`, `not-found`, `conflict`, `invalid`,
`too-large`, `unsupported` or `use-monitor`) and, where they apply, `problems` and `current`.

## Failure, in one place

| What goes wrong | What you see |
|---|---|
| the module is missing, throws on import, or exports no plugin | a notice in pi, a warning from `pa`, a line in the run's `pluginProblems` |
| `setup` throws or takes over 5 s | the same; nothing it registered is kept |
| an observer throws or takes over 5 s | a line in the run's `pluginProblems` (for `run-end`, in its fire log) |
| an action throws or takes over 5 s | a notice in pi; `pa` prints it and exits 2 |
| a renderer fails | the flowchart falls back to fm, then to the step list |

None of these fails a run, stops pi from starting, or changes what any command does.
