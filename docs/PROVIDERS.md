# Providers: composing pi-automations for another host

pi-automations is an automation core with a pi host added to it. The core owns the lifecycle:
discovery, consent, schedules, locks, hooks, records, summaries, viewer lines. Whoever composes it
supplies everything that assumes pi, fm or this machine.

This document is for someone composing a different host. If you only run pi-automations inside pi,
you never need it.

Portable here means Node. The core is a Node ESM package: it reads and writes the filesystem, uses
`node:child_process` for hooks and workers, and keeps durable state in a directory you name. It does
not assume an agent runtime, a flowchart tool, a desktop or a set of directories.

---

## 1. The dependency map

```
             ┌──────────────────────────────────────────────┐
  your host  │  roots · runtime · hooks · workers · notify   │
             └───────────────────────┬──────────────────────┘
                                     │ composed in, one object
             ┌───────────────────────▼──────────────────────┐
  the core   │  dist/core/index.js                          │
             │  fire · runTick · discover · records · locks │
             │  trust · state · paths · pure UI builders    │
             └──────────────────────────────────────────────┘
```

Importing `dist/core/index.js` loads no pi, no fm and no host module, and does nothing: no
discovery, no environment writes, no filesystem or subprocess activity. `test/architecture.test.ts`
checks this in a child process that instruments `fs`, `child_process` and the environment before
the import.

The pi host is one ordinary module beside it, `dist/hosts/pi/compose.js`. Nothing in the core
imports it.

| Layer | Module | May reach |
|---|---|---|
| Portable core | `dist/core/index.js` | Node builtins, `croner`, `yaml` |
| Portable providers | `providers/workspace.js`, `providers/scripts.js`, `providers/worker.js` | Node builtins |
| Legacy codec | `providers/pi/transcript.js` | nothing; it reads pi's file format, not pi |
| pi host | `hosts/pi/*`, `providers/pi/runtime.js`, `providers/fm/*`, `detached/*`, `notify.js` | the pi SDK, fm, the OS |

`providers/pi/transcript.js` is reachable from the core on purpose: a portable host still has to
read transcripts pi wrote. It imports nothing but shared line types.

## 2. What you compose

`fire(located, options, deps)` takes its dependencies as one object. Each field is required or
optional on purpose, and leaving out an optional one has a meaning.

| Field | Required | Absent means |
|---|---|---|
| `config`, `stateDir`, `trust`, `state` | yes | — |
| `runtime: AutomationRuntime` | yes | — |
| `runScript: RunScript` | yes | — |
| `prepareWorkspace` | no | the local git / plain-directory provider |
| `startTracking` | no | every run is untracked |
| `notify` | no | this host raises no notifications |

`runScript` is required and `notify` is not. Without an executor, a configured script (work the
author asked for) would be skipped without a word. Without a sink, the host can only lose a toast
about work that has already finished and been recorded. A host with hooks and no executor gets an
explicit failure, never a quiet success.

`trust` decides what may run at all. Every automation, user or repository, is `off` until the host
has shown the person what it runs and recorded consent with
`trust.arm(located, digestOf(located), interpreters, now, expiryMs)` (the expiry applies to
repository automations only). `fire` records `skipped`
(`not armed`, or `changed since armed: <file>`) for anything else, and `runTick` never starts it.

The core validates three result contracts at its boundary. Each is a discriminated union:

- `RunScript` resolves to `ScriptExecution`: every branch carries `stdout`, `stderr`,
  `outputBytes`, and `truncated`; `exit` additionally requires an integer `exit`, while
  `start-failed` requires a `message`. A plain JavaScript provider that returns a partial object is
  reported as a failed hook, not counted as a success.
- `LaunchWorker` returns a `WorkerHandle`. Its `started` promise confirms either `{ ok: true, pid }`
  or `{ ok: false, reason }`; `completion` is separate and later resolves to either
  `{ end: "exit", exit }` or `{ end: "signal", signal }`. A launch acknowledgment is never a
  completion, and an unreadable completion is never exit zero.
- `SessionHandle.dispose` may be synchronous or asynchronous. Core bounds it before releasing the
  run lock and records a provider diagnostic if it rejects or does not settle.

### Pi SDK compatibility

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are host-provided peers (`"*"`), as
pi's package guidelines require. The minimum supported version is 0.84.4, and the pi host is tested
with these versions:

| Version | Factory invocations | Session replacements | Starts on disposed instance | Shutdowns |
|---|---:|---:|---:|---:|
| `0.84.4` | 3 | 2 | 0 | 3 |
| `0.85.1` | 3 | 2 | 0 | 3 |
| `0.99.2` | 3 | 2 | 0 | 3 |
| `1.2.0` | 3 | 2 | 0 | 3 |

The offline probe drives the SDK's real `AgentSessionRuntime.newSession` and
`loadExtensionsCached` paths while faking only the model, session, and UI. Each replacement creates
a fresh extension controller; shutdown disposes observation state without touching a live worker.
The retained event traces are in `docs/pi-sdk-lifecycle-matrix.json`. Reproduce them with
`npm run verify:sdk-lifecycle`.

## 3. Ownership and failure handling

| Seam | Owner | When it fails |
|---|---|---|
| `AutomationRuntime` | host | model resolution and the session belong to the same instance; a failure becomes an ordinary `failed` or `skipped` record naming the fix, not a stack trace with no record |
| `PrepareWorkspace` | core default, host may replace | a requested worktree that cannot be created refuses the run and records why; it never falls back to the checkout |
| `RunScript` | host | a non-zero exit fails the hook; a timeout is `timeout`; a cancelled hook is `cancelled` and is never read as a clean exit |
| `StartFlowTracking` | host (core ships `progressTracking`) | best effort: after the first failure the tracker goes quiet for that run, and the run is unaffected |
| `RenderChart` | host | a renderer that is absent or fails means the viewer shows the step list; it never blocks a run |
| `LaunchWorker` | host | `release()` stops observing the worker; it cannot end the worker |
| `Notify` | host | core calls it only for `failed`, and only when `notifyOnFailed` says so |
| `TranscriptDecoder` | host | an unknown format is named in the message, never guessed; see §6 |

Nothing in this table can end a run. Only the run's own body, a hook that fails, or the stop file
can.

## 4. The runtime

Model resolution and session startup are one integration:

```ts
interface AutomationRuntime {
  resolveModel(spec: string | undefined): Promise<RuntimeModelRef>;
  startSession(start: RuntimeSessionStart): Promise<SessionHandle>;
}
```

Return both from one object. `resolveModel` returns a `RuntimeModelRef`, a portable identity
(provider, id, display string), and keeps whatever native handle it resolved private to that
instance. `startSession` is handed the reference back and looks up its
own native value. No `raw: unknown` crosses a portable contract, and the instance that resolved a
model is the one that opens the session with it.

`RuntimeModelRef` is a plain type you can satisfy by returning an ordinary object; there is no
brand to forge and no cast to write. Ownership is enforced at runtime instead, by object identity:
each runtime keeps its native model in a private map keyed by the reference it handed out, so a
reference from another runtime, or a structural copy of one, maps to nothing and is refused before
the vendor SDK is touched. The pi runtime does this, and refuses such a reference as a host fault, because handing one runtime another's model is a composition mistake rather than
anything the agent did.

## 5. Progress, flowchart rendering and notifications

All three are composed in; there is nothing to subclass.

Tracking is a `fire` dependency. Drawing a flowchart is a viewer dependency. They are separate
because a run records progress while it runs, and a viewer draws it whenever somebody looks.

```ts
// Tracking, in fire's deps. The pi host composes the core progress store (`pa` writes to the
// same one); yours can compose it too, or nothing.
startTracking: progressTracking,     // or undefined: every run is untracked, and nothing is lost

// Drawing, in the viewer's options: the plan and each node's status in, text out — or a problem.
createFlowViewer({
  render: ({ plan, state, format }) => myRenderer(plan, state, format),   // or omit: the step list
});

// Notifications, in fire's deps. Absent is a legitimate host, not a fault.
notify: undefined,                   // or: async (rec) => myAlert(rec)
```

A renderer returns `{ problem }` rather than throwing; the viewer then shows the step list, and the
run is not affected either way. The core never learns what drew a flowchart or what raised a toast.
`test/notification-provider.test.ts` checks that a test host delivers nothing to a desktop.

## 6. Transcripts and the format seam

A record's `session` carries `{ file, id, format? }`. `format` is omitted for pi, so pi's records
stay byte-identical; any other host sets its own tag.

```ts
const read = decodeTranscript(text, record.session, {
  legacy: parseSessionLines,                         // untagged ⇒ pi JSONL
  alternative: { format: "yours/v1", decode: yours },
});
if (!read.ok) showLines(unsupportedFormatLines(read.unsupported, width));
```

`parseSessionLines` is pi's legacy decoder. It is exported from the core entry and from
`providers/pi/transcript.js`, and it loads no SDK, because the format is only a file layout.

An unknown tag is named in the message, for empty content and for a missing file too. "Nothing to
show" explains nothing, and a guess at which host wrote it sends people to install the wrong one.

## 7. Explicit host paths

A host says where its directories are.

```ts
import { runTick } from "pi-automations/dist/tick.js";  // the portable one

const host = { home: "/home/me", agentDir: "/home/me/.myagent" };
const roots = userRootsFor(host);          // <home>/.agents/automations, <agentDir>/automations
const state = path.join(host.agentDir, "pi-automations");

await runTick({ stateDir: state, host, spawnFire, modelResolver });
```

`runTick` takes `host` or an explicit `roots` array. Omitting both makes discovery read the
process's own home, which is right for a real host and wrong for a test.

### Which `runTick` you get

There are two, and the import path decides:

| import | `spawnFire` | for |
|---|---|---|
| `dist/tick.js` (also `dist/core/index.js`) | required | a portable host; no pi is reachable from it |
| `dist/index.js` | optional, defaults to pi | the pi host |

A host that might not be pi cannot be handed a pi default, so the portable one requires a transport
and will not compile without one. The pi entry composes the pi transport when none is passed and
then calls the same implementation.

`setAgentDir()` exists for the one process that must agree with pi about the agent directory; a
non-pi host does not call it.

## 8. The worked example runs

The example is the fixture the test suite runs, from a clone of this repository.

| File | What it is |
|---|---|
| `test/fixtures/portable-lifecycle.mjs` | composes the core and runs success, failure, cancellation, listing, session rendering and legacy decoding |
| `test/fixtures/portable-runtime.mjs` | a deterministic offline `AutomationRuntime`, typed against the real contracts and checked by `npm run typecheck` |
| `test/fixtures/portable-worker.js` | a worker entrypoint a non-pi host composes |
| `test/fixtures/portable-deny-sdk.mjs` | a loader that refuses to import the pi SDK, to prove the example runs without it |

```
npm run build
node ./test/fixtures/portable-lifecycle.mjs ok ./tmp-portable-demo
node --import ./test/fixtures/portable-deny-sdk.mjs ./test/fixtures/portable-lifecycle.mjs ok ./tmp-portable-demo
```

The last argument is a directory the example creates its state, roots and sessions under. Modes are
`ok`, `fail`, `cancel` and `decode`; each prints one JSON line.

## 9. What a correct host looks like

`test/portable-host.test.ts` runs the real `bin/tick.js`, `runTick`, tick lock, worker transport and
core `fire`, substituting only `dist/hosts/pi/compose.js`, the module that chooses a host. The tick
starts a run and exits; the worker outlives it and writes its own record. Every host should work
this way.