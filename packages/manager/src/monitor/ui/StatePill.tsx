import type { AutomationSummary, Outcome } from '../../host/contract';

export function StatePill({ summary }: { summary: AutomationSummary }) {
  const tone = summary.running ? 'running' : summary.state;
  return <span className={`am-state-pill am-state-pill--${tone}`}>{tone}</span>;
}

export function OutcomeDots({ outcomes }: { outcomes: Outcome[] }) {
  return (
    <span className="am-outcome-dots" aria-label="recent outcomes">
      {outcomes.slice(-7).map((outcome, index) => <i key={`${outcome}-${index}`} className={`am-dot am-dot--${outcome}`} />)}
    </span>
  );
}

