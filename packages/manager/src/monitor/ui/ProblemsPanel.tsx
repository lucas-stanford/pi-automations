import type { Problem } from '../../host/contract';

export const PROBLEMS_ID = 'am-problems';

/** One line per problem, under the tabs. The Problems button in the tab bar shows and hides it. */
export function ProblemsPanel({ problems, open }: { problems: Problem[]; open: boolean }) {
  if (problems.length === 0 || !open) return null;
  return (
    <ul id={PROBLEMS_ID} className="am-problems-panel" aria-label="Problems">
      {problems.map((problem) => (
        <li key={`${problem.file}-${problem.field}-${problem.line}-${problem.message}`} className={`am-problem am-problem--${problem.severity}`}>
          <span className="am-problem__severity">{problem.severity}</span>
          <span className="am-problem__where">{problem.file}{problem.line ? `:${problem.line}` : ''}</span>
          <span className="am-problem__message">{problem.field ? `${problem.field}: ` : ''}{problem.message}</span>
        </li>
      ))}
    </ul>
  );
}
