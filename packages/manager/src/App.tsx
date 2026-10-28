import { useEffect, useState } from 'react';

import { probeSession, ManagerError } from './host/client';
import type { SessionInfo } from './host/contract';
import { MonitorApp } from './monitor/MonitorApp';
import { useTheme } from './theme/useTheme';

type Mode =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'monitor'; session: SessionInfo }
  | { kind: 'error'; message: string };

export default function App() {
  const { theme, resolved, cycle } = useTheme();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void probeSession()
      .then((session) => {
        if (active) setMode(session ? { kind: 'monitor', session } : { kind: 'offline' });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMode(error instanceof ManagerError && error.kind === 'api-version' ? { kind: 'error', message: error.message } : { kind: 'offline' });
      });
    return () => { active = false; };
  }, []);

  if (mode.kind === 'loading') {
    return <div className="mode-loading">Opening the Automation Manager…</div>;
  }
  if (mode.kind === 'error') {
    return <main className="am-home"><section className="am-banner am-banner--error"><h1>Version mismatch</h1><p>{mode.message}</p></section></main>;
  }
  if (mode.kind === 'offline') {
    return (
      <main className="am-home">
        <section className="am-banner am-banner--warning" role="status">
          <h1>Automation Manager is not connected</h1>
          <p>Open it from pi-automations: press <kbd>e</kbd> on an automation in <code>/automations</code>, or run <code>pa edit &lt;name&gt;</code>.</p>
        </section>
      </main>
    );
  }
  return <MonitorApp session={mode.session} theme={theme} resolvedTheme={resolved} onCycleTheme={cycle} />;
}
