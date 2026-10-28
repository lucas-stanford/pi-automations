import type { Problem } from '../../host/contract';
import { Button } from './Button';

export function ConflictBanner({ onReload, onReview, onOverwrite }: { onReload: () => void; onReview: () => void; onOverwrite: () => void }) {
  return (
    <section className="am-banner am-banner--warning" role="alert">
      <strong>Changed on disk since you opened it.</strong>
      <span>Reload drops your edits. Overwrite saves yours over the file on disk.</span>
      <div className="am-button-row">
        <Button type="button" onClick={onReload}>Reload</Button>
        <Button type="button" onClick={onReview}>Review</Button>
        <Button type="button" variant="primary" onClick={onOverwrite}>Overwrite</Button>
      </div>
    </section>
  );
}

export function InvalidBanner({ problems, onSaveAnyway }: { problems: Problem[]; onSaveAnyway: () => void }) {
  return (
    <section className="am-banner am-banner--error" role="alert">
      <strong>This draft is invalid.</strong>
      <ul>{problems.map((problem) => <li key={`${problem.file}-${problem.field}-${problem.message}`}>{problem.field ? `${problem.field}: ` : ''}{problem.message}</li>)}</ul>
      <Button type="button" variant="primary" onClick={onSaveAnyway}>Save anyway</Button>
    </section>
  );
}

