import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import type { Problem } from '../../host/contract';

function fieldProblems(problems: Problem[], field?: string): Problem[] {
  if (!field) return [];
  return problems.filter((problem) => problem.field === field || problem.field?.startsWith(`${field}.`) || problem.field?.startsWith(`${field}[`));
}

export function Field({ label, hint, field, problems = [], children }: { label: string; hint?: ReactNode; field?: string; problems?: Problem[]; children: ReactNode }) {
  const ownProblems = fieldProblems(problems, field);
  return (
    <label className="am-field">
      <span className="am-field__label">{label}</span>
      {children}
      {hint && <span className="am-field__hint">{hint}</span>}
      {ownProblems.map((problem) => <span key={`${problem.file}-${problem.field}-${problem.message}`} className={`am-field__problem am-field__problem--${problem.severity}`}>{problem.message}</span>)}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`am-input ${props.className ?? ''}`.trim()} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`am-textarea ${props.className ?? ''}`.trim()} />;
}

