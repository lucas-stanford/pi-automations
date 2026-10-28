import type { AutomationIndex, AutomationSummary } from '../../host/contract';
import { formatAge, nextText, summarySchedule } from './format';
import { OutcomeDots, StatePill } from './StatePill';

function AutomationRow({ automation }: { automation: AutomationSummary }) {
  const facts = [
    summarySchedule(automation),
    nextText(automation),
    automation.last ? `${automation.last.outcome} · ${formatAge(automation.last.at)}` : 'no runs',
  ].filter(Boolean);
  return (
    <a className="am-automation-row" href={`/automations/${automation.id}?tab=flow`}>
      <div className="am-automation-row__main">
        <div className="am-automation-row__title">
          <span className="am-state-dot" data-state={automation.running ? 'running' : automation.state} />
          <strong>{automation.name}</strong>
          <StatePill summary={automation} />
          {automation.tracked && <span className="am-tracked" title="tracked on a flowchart">⋔</span>}
        </div>
        <p>{automation.description || 'No description'}</p>
        {automation.reason && <p className="am-reason">{automation.reason}</p>}
      </div>
      <div className="am-automation-row__meta">
        <span>{facts.join(' · ')}</span>
        <OutcomeDots outcomes={automation.recent} />
      </div>
    </a>
  );
}

function statusLine(automations: AutomationSummary[]): string {
  const running = automations.filter((a) => a.running).length;
  const invalid = automations.filter((a) => a.state === 'invalid').length;
  const parts = [running ? `${running} running` : '', invalid ? `${invalid} invalid` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nothing running';
}

export function Home({ index }: { index: AutomationIndex }) {
  const missing = new URLSearchParams(window.location.search).get('missing');
  const automations = index.groups.flatMap((group) => group.automations);
  return (
    <main className="am-home">
      {missing && <section className="am-banner am-banner--warning">No automation named <code>{missing}</code> was found.</section>}
      <header className="am-page-title">
        <h1>Automations</h1>
        <span>{automations.length}</span>
        <p>{statusLine(automations)}</p>
      </header>
      {index.groups.map((group) => (
        <section className="am-home-group" key={group.id}>
          <h2>{group.title}</h2>
          <div className="am-list-card">
            {group.automations.map((automation) => <AutomationRow key={automation.id} automation={automation} />)}
          </div>
        </section>
      ))}
    </main>
  );
}
