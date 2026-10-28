import { useEffect, useState } from 'react';
import type { AutomationBundle, LiveProgress, RunNote, RunStep, RunSummary } from '../../host/contract';
import type { ManagerClient } from '../../host/client';
import { formatAge, formatDuration } from './format';
import { MarkdownView } from './MarkdownView';
import { firstLine, MessageSection, NotesList, shownMessage } from './RunMessage';
import { RunGraph, statusWord } from './RunGraph';

/** How often a running run's progress is read while it is shown. */
const LIVE_POLL_MS = 1500;
/** How often the run list is read again while the tab is open, so a run that ends shows up. */
const RUNS_POLL_MS = 5000;

const LIVE_ID = 'live';

function StepsList({ steps }: { steps: RunStep[] }) {
  return (
    <ol className="am-run-steps" aria-label="Steps">
      {steps.map((step) => (
        <li key={step.id}>
          <span className={`am-dot am-dot--step-${step.status}`} />
          <span><code>{step.id}</code> {step.label}</span>
          <span>{statusWord(step.status)}</span>
          {step.text && <span className="am-muted">{step.text}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The chart, the steps under it, and the notes: the same for a finished run and a running one. */
function Progress({ chart, steps, taken, notes, notesShown = false }: { chart?: string; steps?: RunStep[]; taken?: [string, string][]; notes?: RunNote[]; notesShown?: boolean }) {
  return (
    <>
      {chart && steps && steps.length > 0 ? (
        <section className="am-run-section">
          <h3>Flowchart</h3>
          <RunGraph chart={chart} steps={steps} taken={taken ?? []} />
          <StepsList steps={steps} />
        </section>
      ) : (
        <p className="am-muted">This run was not tracked on a flowchart.</p>
      )}
      {!notesShown && (
        <section className="am-run-section">
          <h3>Notes</h3>
          <NotesList notes={notes ?? []} />
        </section>
      )}
    </>
  );
}

/** Leads with what the run left for its reader; its notes are not shown twice. */
function RunDetail({ run }: { run: RunSummary }) {
  const shown = shownMessage(run);
  return (
    <>
      <MessageSection shown={shown} notes={run.notes} />
      {shown?.from !== 'reply' && <p className="am-muted">{run.error?.message ?? run.reason ?? run.summary}</p>}
      <Progress chart={run.chart} steps={run.steps} taken={run.taken} notes={run.notes} notesShown={shown?.from === 'notes'} />
      {run.flow?.problem && <p className="am-banner am-banner--warning">Steps could not be recorded: {run.flow.problem}</p>}
      {(run.pluginProblems ?? []).map((problem) => <p key={problem} className="am-banner am-banner--warning">{problem}</p>)}
      {run.hooks.length > 0 && (
        <section className="am-run-section">
          <h3>Hooks</h3>
          <table>
            <thead><tr><th scope="col">Hook</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Exit</th><th scope="col">Time</th><th scope="col">Reason</th></tr></thead>
            <tbody>
              {run.hooks.map((hook) => <tr key={`${hook.phase}-${hook.index}-${hook.source}`}><td>{hook.phase}[{hook.index}]</td><td>{hook.source}</td><td>{hook.status}</td><td>{hook.exit ?? ''}</td><td>{formatDuration(hook.durationMs)}</td><td>{hook.reason ?? ''}</td></tr>)}
            </tbody>
          </table>
        </section>
      )}
      {run.output && (
        <section className="am-run-section">
          <h3>Answer</h3>
          <MarkdownView text={`${run.output.text}${run.output.truncated ? '\n\n_Answer cut short._' : ''}`} />
        </section>
      )}
    </>
  );
}

function LiveDetail({ live, startedAt }: { live: LiveProgress | null; startedAt: string }) {
  const shown = live ? shownMessage(live) : undefined;
  return (
    <>
      {live && <MessageSection shown={shown} notes={live.notes} live />}
      <p>Started {formatAge(startedAt)}.</p>
      {live ? <Progress chart={live.chart || undefined} steps={live.steps} taken={live.taken} notes={live.notes} notesShown={shown?.from === 'notes'} /> : <p className="am-muted">Reading its progress…</p>}
    </>
  );
}

export function RunsTab({
  bundle,
  client,
  id,
  onRuns,
  initialRun,
}: {
  bundle: AutomationBundle;
  client: ManagerClient;
  id: string;
  /** A fresher list of runs, and whether one is going: merged into the page without touching the draft. */
  onRuns: (fresh: AutomationBundle) => void;
  /** The run to open first, e.g. one chosen in History. */
  initialRun?: string;
}) {
  const running = bundle.summary.running;
  const runningId = running?.runId;
  const wanted = initialRun && bundle.runs.some((r) => r.id === initialRun) ? initialRun : undefined;
  const [selected, setSelected] = useState(wanted ?? (running ? LIVE_ID : (bundle.runs[0]?.id ?? '')));
  const tooOld = Boolean(initialRun) && !wanted && initialRun !== runningId;
  const [live, setLive] = useState<LiveProgress | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void client.bundle(id).then(onRuns).catch(() => undefined);
    }, RUNS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, id, onRuns]);

  useEffect(() => {
    if (!runningId) {
      setLive(null);
      return undefined;
    }
    let active = true;
    const read = () =>
      void client
        .progress(id, runningId)
        .then((p) => {
          if (active) setLive(p);
        })
        // Ended between two reads: its record has it now.
        .catch(() => {
          if (active) void client.bundle(id).then(onRuns).catch(() => undefined);
        });
    read();
    const timer = window.setInterval(read, LIVE_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, id, runningId, onRuns]);

  const showLive = Boolean(running) && selected === LIVE_ID;
  const run = showLive ? undefined : (bundle.runs.find((item) => item.id === selected) ?? bundle.runs[0]);
  return (
    <div className="am-runs-grid">
      <section className="am-panel">
        <header className="am-panel__header"><h2>Runs</h2></header>
        <div className="am-panel__body am-run-list">
          {tooOld && <p className="am-banner am-banner--info">That run is older than the twenty shown here. <a href="/history">History</a> has it.</p>}
          {running && (
            <button type="button" className="am-run-row" aria-current={showLive ? 'true' : undefined} onClick={() => setSelected(LIVE_ID)}>
              <span className="am-run-row__head">
                <span className="am-dot am-dot--running" />
                <strong>running</strong>
                <span title={running.startedAt}>{formatAge(running.startedAt)}</span>
              </span>
              <span className="am-run-row__summary">{running.runId}</span>
            </button>
          )}
          {bundle.runs.length === 0 && !running && <p className="am-muted">No runs yet.</p>}
          {bundle.runs.map((item) => (
            <button type="button" key={item.id} className="am-run-row" aria-current={!showLive && item.id === run?.id ? 'true' : undefined} onClick={() => setSelected(item.id)}>
              <span className="am-run-row__head">
                <span className={`am-dot am-dot--${item.outcome}`} />
                <strong>{item.outcome}</strong>
                <span>{item.trigger}</span>
                <span title={item.recordedAt}>{formatAge(item.recordedAt)}</span>
                <span>{formatDuration(item.durationMs)}</span>
              </span>
              {item.message ? (
                <span className="am-run-row__summary am-run-row__message" title={item.message.text}>{firstLine(item.message.text)}{item.message.links.length > 0 ? ` · ${item.message.links.length} link${item.message.links.length === 1 ? '' : 's'}` : ''}</span>
              ) : (
                item.summary && <span className="am-run-row__summary" title={item.summary}>{item.summary}</span>
              )}
              {item.model && <span className="am-run-row__model">{item.model}</span>}
            </button>
          ))}
        </div>
      </section>
      <section className="am-panel">
        <header className="am-panel__header"><h2>Run</h2></header>
        <div className="am-panel__body am-run-detail">
          {showLive && running ? <LiveDetail live={live} startedAt={running.startedAt} /> : run ? <RunDetail run={run} /> : <p className="am-muted">Select a run.</p>}
        </div>
      </section>
    </div>
  );
}
