import type { ReactNode } from 'react';
import type { Theme } from '../../theme/useTheme';

export function AppShell({ theme, onCycleTheme, page = 'automations', children }: { theme: Theme; onCycleTheme: () => void; page?: 'automations' | 'history'; children: ReactNode }) {
  return (
    <div className="am-shell">
      <header className="am-topbar">
        <div className="am-brand">
          <strong>Automation Manager</strong>
          <span>pi-automations</span>
        </div>
        <nav className="am-mainnav" aria-label="Primary">
          <a href="/" aria-current={page === 'automations' ? 'page' : undefined}>Automations</a>
          <a href="/history" aria-current={page === 'history' ? 'page' : undefined}>History</a>
        </nav>
        <button className="am-theme-button" type="button" onClick={onCycleTheme} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Click to change.`}>
          {theme === 'system' ? '◐' : theme === 'dark' ? '☾' : '☀'}
        </button>
      </header>
      {children}
    </div>
  );
}
