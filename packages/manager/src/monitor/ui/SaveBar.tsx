import { Button } from './Button';

export function SaveBar({
  dirty,
  status,
  onSave,
  onRevert,
  onReview,
}: {
  dirty: boolean;
  status: string;
  onSave: () => void;
  onRevert: () => void;
  onReview: () => void;
}) {
  return (
    <div className="am-savebar">
      <span className={`am-dirty-dot ${dirty ? 'am-dirty-dot--dirty' : ''}`} role="img" aria-label={dirty ? 'Unsaved changes' : 'No unsaved changes'} />
      <Button type="button" variant="primary" disabled={!dirty} onClick={onSave}>Save</Button>
      <Button type="button" disabled={!dirty} onClick={onRevert}>Revert</Button>
      <Button type="button" onClick={onReview}>Review changes</Button>
      <span className="am-save-status" aria-live="polite">{status}</span>
    </div>
  );
}
