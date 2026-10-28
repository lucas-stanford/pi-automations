import { useId } from 'react';
import type { ModelList, ModelOption, Problem } from '../../host/contract';

/** The Model field's suggestions, and the way to read them from pi again. */
export interface ModelChoices {
  list: ModelList;
  refreshing: boolean;
  refresh: () => void;
}

const SOURCE: Record<ModelOption['source'], string> = {
  enabled: 'enabled in pi',
  automation: 'used by an automation',
  available: 'available in pi',
};

const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;

/**
 * What the dropdown shows for a value. Chrome and Edge show it beside the value; Firefox shows it
 * instead of the value, so it has to tell models apart on its own.
 */
export function modelOptionLabel(option: ModelOption): string {
  const level = THINKING.exec(option.value)?.[1];
  const name = option.name ? `${option.name}${level ? ` (${level})` : ''}` : option.value;
  return `${name} · ${SOURCE[option.source]}`;
}

/** Labels for every option, using the model id wherever two labels would read the same. */
export function modelOptionLabels(options: ModelOption[]): string[] {
  const labels = options.map(modelOptionLabel);
  return labels.map((label, index) => (labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${options[index].value} · ${SOURCE[options[index].source]}`));
}

/** The line under the field: where the list came from, or why it is short. */
export function modelListNote(list: ModelList, refreshing: boolean): string {
  if (refreshing) return 'Reading the models pi can run…';
  if (list.error) return `Could not read pi's models: ${list.error}`;
  if (!list.readAt) return 'Only models automations already use.';
  const at = new Date(list.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${list.models.length} models from pi, read at ${at}.`;
}

export function ModelField({ value, onChange, choices, problems }: { value: string; onChange: (value: string) => void; choices: ModelChoices; problems: Problem[] }) {
  const inputId = useId();
  const listId = useId();
  const own = problems.filter((problem) => problem.field === 'model');
  const labels = modelOptionLabels(choices.list.models);
  return (
    <div className="am-field">
      <div className="am-field__row">
        <label className="am-field__label" htmlFor={inputId}>Model</label>
        <button
          type="button"
          className="am-icon-button"
          onClick={choices.refresh}
          disabled={choices.refreshing}
          aria-label="Refresh the model list from pi"
          title="Read the models pi can run again"
        >
          ↻
        </button>
      </div>
      <input id={inputId} className="am-input" list={listId} value={value} placeholder="host default" onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {choices.list.models.map((option, index) => <option key={option.value} value={option.value} label={labels[index]} />)}
      </datalist>
      <span className="am-field__hint">provider/model[:thinking]</span>
      <span className={`am-field__hint${choices.list.error ? ' am-field__hint--warning' : ''}`} role="status">{modelListNote(choices.list, choices.refreshing)}</span>
      {own.map((problem) => <span key={`${problem.file}-${problem.message}`} className={`am-field__problem am-field__problem--${problem.severity}`}>{problem.message}</span>)}
    </div>
  );
}
