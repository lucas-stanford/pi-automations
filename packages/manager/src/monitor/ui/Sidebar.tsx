import { useMemo, useState } from 'react';
import type { AutomationIndex } from '../../host/contract';

export function Sidebar({ index, selected }: { index: AutomationIndex | null; selected: string }) {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => index?.groups.map((group) => ({
    ...group,
    automations: group.automations.filter((automation) => automation.name.toLowerCase().includes(filter.toLowerCase())),
  })) ?? [], [filter, index]);
  return (
    <aside className="am-sidebar">
      <label className="am-sidebar__filter">
        <span className="am-section-label">Filter</span>
        <input className="am-input" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="automation name" />
      </label>
      {groups.map((group) => (
        <section key={group.id}>
          <h2>{group.title}</h2>
          {group.automations.map((automation) => (
            <a key={automation.id} className="am-sidebar-row" aria-current={automation.id === selected ? 'page' : undefined} href={`/automations/${automation.id}?tab=flow`}>
              <span className="am-state-dot" data-state={automation.running ? 'running' : automation.state} />
              <span>{automation.name}</span>
              {automation.tracked && <span className="am-tracked">⋔</span>}
            </a>
          ))}
        </section>
      ))}
    </aside>
  );
}

