import type { AutomationBundle } from '../../host/contract';
import { nextText, summarySchedule } from './format';
import { SaveBar } from './SaveBar';
import { StatePill } from './StatePill';

export function AutomationHeader({
  bundle,
  dirty,
  status,
  onSave,
  onRevert,
  onReview,
}: {
  bundle: AutomationBundle;
  dirty: boolean;
  status: string;
  onSave: () => void;
  onRevert: () => void;
  onReview: () => void;
}) {
  const meta = [
    bundle.summary.scope,
    bundle.summary.dir,
    summarySchedule(bundle.summary),
    nextText(bundle.summary),
    bundle.flow.source === 'automation' ? '⋔ flowchart' : bundle.flow.source === 'file' ? '⋔ flow.mmd' : bundle.flow.source === 'config' ? '⋔ config' : 'not tracked',
    bundle.summary.running ? `running ${bundle.summary.running.runId}` : null,
  ].filter(Boolean);
  return (
    <section className="am-editor-header">
      <div>
        <div className="am-editor-title">
          <h1>{bundle.summary.name}</h1>
          <StatePill summary={bundle.summary} />
          {bundle.summary.reason && <span className="am-reason">{bundle.summary.reason}</span>}
        </div>
        <p className="am-editor-meta">
          {meta.join(' · ')}
        </p>
      </div>
      <SaveBar dirty={dirty} status={status} onSave={onSave} onRevert={onRevert} onReview={onReview} />
      {bundle.notices.map((notice) => <div key={notice.message} className={`am-banner am-banner--${notice.tone}`}>{notice.message}</div>)}
    </section>
  );
}
