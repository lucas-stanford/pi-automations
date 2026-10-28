import { useEffect, useState, type MouseEvent } from 'react';
import type { AutomationIndex, HistoryPage as HistoryData, HistoryRun, Outcome } from '../../host/contract';
import type { ManagerClient } from '../../host/client';
import { formatAge, formatDuration } from './format';
import { MarkdownView } from './MarkdownView';
import { LinkChips, shownMessage } from './RunMessage';

const OUTCOMES: Outcome[] = ['ok', 'failed', 'skipped', 'missed', 'aborted'];

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: HistoryData };

function runHref(run: HistoryRun): string {
  return `/automations/${encodeURIComponent(run.automation.id)}?tab=runs&run=${encodeURIComponent(run.id)}`;
}

function HistoryRow({ run }: { run: HistoryRun }) {
  const shown = shownMessage(run);
  const href = runHref(run);
  // The whole row opens the run, except where a link inside it was clicked.
  const open = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) return;
    window.location.assign(href);
  };
  return (
    <li className="am-history-row" onClick={open}>
      <div className="am-history-row__message">
        {/* A run that left no message or notes shows what it said, quieter and as plain text. */}
        {!shown ? <p className="am-muted">No message.</p> : shown.from === 'reply' ? <p className="am-history-row__reply">{shown.text}</p> : <MarkdownView text={shown.text} />}
        <LinkChips links={shown?.links ?? []} />
      </div>
      <a className="am-history-row__meta" href={href} aria-label={`${run.automation.name}, ${run.outcome}, ${formatAge(run.endedAt ?? run.recordedAt)}: open the run`}>
        <span className={`am-dot am-dot--${run.outcome}`} />
        <strong>{run.automation.name}</strong>
        <span>{run.outcome}</span>
        <time dateTime={run.endedAt ?? run.recordedAt} title={run.endedAt ?? run.recordedAt}>{formatAge(run.endedAt ?? run.recordedAt)}</time>
        <span>{formatDuration(run.durationMs)}</span>
      </a>
    </li>
  );
}

/** Every automation's runs, newest first, each led by what it left for its reader. */
export function HistoryPage({ client, index }: { client: ManagerClient; index: AutomationIndex | null }) {
  const params = new URLSearchParams(window.location.search);
  const [automation, setAutomation] = useState(params.get('automation') ?? '');
  const [outcome, setOutcome] = useState<Outcome | ''>(OUTCOMES.find((o) => o === params.get('outcome')) ?? '');
  const [onlyMessages, setOnlyMessages] = useState(params.get('message') === '1');
  const [state, setState] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    const next = new URLSearchParams();
    if (automation) next.set('automation', automation);
    if (outcome) next.set('outcome', outcome);
    if (onlyMessages) next.set('message', '1');
    const search = next.toString();
    window.history.replaceState(null, '', `/history${search ? `?${search}` : ''}`);

    let active = true;
    const read = () =>
      void client
        .history({ ...(automation ? { automation } : {}), ...(outcome ? { outcome } : {}), message: onlyMessages })
        .then((value) => active && setState({ status: 'ready', value }))
        .catch((error: unknown) => active && setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not read the history' }));
    read();
    const timer = window.setInterval(() => {
      if (!document.hidden) read();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, automation, outcome, onlyMessages]);

  const automations = (index?.groups ?? []).flatMap((g) => g.automations).sort((a, b) => a.name.localeCompare(b.name));
  const runs = state.status === 'ready' ? state.value.runs : [];
  return (
    <main className="am-home am-history">
      <header className="am-page-title">
        <h1>History</h1>
        {state.status === 'ready' && <span>{runs.length}{state.value.more ? '+' : ''}</span>}
        <p>every automation's runs, newest first</p>
      </header>
      <div className="am-history-filters" role="group" aria-label="Filters">
        <label className="am-field">
          <span className="am-field__label">Automation</span>
          <select className="am-input" value={automation} onChange={(e) => setAutomation(e.target.value)}>
            <option value="">All automations</option>
            {automations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="am-field">
          <span className="am-field__label">Outcome</span>
          <select className="am-input" value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | '')}>
            <option value="">Any outcome</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="am-switch">
          <input type="checkbox" checked={onlyMessages} onChange={(e) => setOnlyMessages(e.target.checked)} />
          <span>Only runs with a message or notes</span>
        </label>
      </div>
      {state.status === 'loading' && <p className="am-muted">Reading the history…</p>}
      {state.status === 'error' && <section className="am-banner am-banner--error">{state.message}</section>}
      {state.status === 'ready' && runs.length === 0 && <p className="am-muted">No runs match.</p>}
      {runs.length > 0 && (
        <ol className="am-list-card am-history-list" aria-label="Runs">
          {runs.map((run) => <HistoryRow key={`${run.automation.id}/${run.id}`} run={run} />)}
        </ol>
      )}
      {state.status === 'ready' && state.value.more && <p className="am-muted">Showing the newest {state.value.limit}. Narrow it with the filters to see older runs.</p>}
    </main>
  );
}
