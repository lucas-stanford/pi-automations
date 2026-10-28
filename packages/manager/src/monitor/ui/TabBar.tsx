import type { EditorTab } from '../../host/contract';
import { PROBLEMS_ID } from './ProblemsPanel';

const TABS: EditorTab[] = ['flow', 'instructions', 'files', 'runs', 'source'];
/** The ids stay as they are in URLs (`?tab=instructions`); the labels use the format's words. */
const LABELS: Record<EditorTab, string> = { flow: 'Flowchart', instructions: 'Body', files: 'Files', runs: 'Runs', source: 'Source' };

export function TabBar({ tab, problems, problemsOpen, onToggleProblems, onChange }: { tab: EditorTab; problems: number; problemsOpen: boolean; onToggleProblems: () => void; onChange: (tab: EditorTab) => void }) {
  return (
    <div className="am-tabbar">
      <div role="tablist" aria-label="Automation editor tabs">
        {TABS.map((item) => (
          <button key={item} id={`am-tab-${item}`} type="button" role="tab" aria-controls="am-editor-panel" aria-selected={tab === item} onClick={() => onChange(item)}>
            {LABELS[item]}
          </button>
        ))}
      </div>
      {problems > 0 ? (
        <button
          className="am-problems-link"
          type="button"
          aria-expanded={problemsOpen}
          aria-controls={problemsOpen ? PROBLEMS_ID : undefined}
          title={problemsOpen ? 'Hide problems' : 'Show problems'}
          onClick={onToggleProblems}
        >
          Problems <span className="am-badge">{problems}</span>
        </button>
      ) : (
        <span className="am-problems-link am-muted">No problems</span>
      )}
    </div>
  );
}
