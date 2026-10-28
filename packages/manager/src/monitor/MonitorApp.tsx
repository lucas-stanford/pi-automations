import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import type { AutomationBundle, AutomationIndex, ComposeResult, ErrorBody, ModelList, Problem, SessionInfo, EditorTab } from '../host/contract';
import { ManagerClient, ManagerError } from '../host/client';
import type { ResolvedTheme, Theme } from '../theme/useTheme';
import { draftFromBundle, flowTextAfterSave, toMonitorDraft, type MonitorDraftState } from './draft';
import { AppShell } from './ui/AppShell';
import { AutomationHeader } from './ui/AutomationHeader';
import { ConflictBanner, InvalidBanner } from './ui/Banners';
import { DiffDrawer } from './ui/DiffDrawer';
import { FilesTab } from './ui/FilesTab';
import { FlowCanvas, type Selection } from './ui/FlowCanvas';
import { HistoryPage } from './ui/HistoryPage';
import { Home } from './ui/Home';
import { Inspector } from './ui/Inspector';
import { InstructionsTab } from './ui/InstructionsTab';
import { ProblemsPanel } from './ui/ProblemsPanel';
import { RunsTab } from './ui/RunsTab';
import { Sidebar } from './ui/Sidebar';
import { SourceTab } from './ui/SourceTab';
import { TabBar } from './ui/TabBar';
import './ui/monitor.css';

interface MonitorAppProps {
  session: SessionInfo;
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  onCycleTheme: () => void;
}

type LoadState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

function routeId(): string | null {
  const match = window.location.pathname.match(/^\/automations\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routeRun(): string | undefined {
  return new URLSearchParams(window.location.search).get('run') ?? undefined;
}

function isHistoryRoute(): boolean {
  return /^\/history\/?$/.test(window.location.pathname);
}

function routeTab(): EditorTab {
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'instructions' || value === 'files' || value === 'runs' || value === 'source' ? value : 'flow';
}

function revisionFromError(error: ManagerError, current: AutomationBundle): AutomationBundle {
  const body = error.body;
  if (!body?.current) return current;
  return {
    ...current,
    files: {
      automation: body.current.automation ? { ...current.files.automation, revision: body.current.automation } : current.files.automation,
      flow: current.files.flow && body.current.flow !== undefined ? { ...current.files.flow, revision: body.current.flow ?? current.files.flow.revision } : current.files.flow,
    },
  };
}

/** What a save would change, against disk — never a rewrite the save will not make. */
export function diffFor(bundle: AutomationBundle, draft: MonitorDraftState, compose: ComposeResult | null): string {
  const sentDraft = toMonitorDraft(draft);
  const sendsChart = sentDraft.flowText !== undefined;
  const automationText = sendsChart
    ? compose?.automationText ?? bundle.files.automation.text
    : draft.automationText ?? compose?.automationText ?? bundle.files.automation.text;
  const chartOnDisk = bundle.flow.text ?? bundle.files.flow?.text ?? null;
  const flowAfter = flowTextAfterSave(draft, chartOnDisk);
  const automationDiff = createTwoFilesPatch('AUTOMATION.md (disk)', 'AUTOMATION.md (draft)', bundle.files.automation.text, automationText);
  const flowDiff = bundle.files.flow
    ? createTwoFilesPatch('flow.mmd (disk)', 'flow.mmd (draft)', bundle.files.flow.text, compose ? compose.flowFileText ?? '' : sendsChart ? '' : flowAfter ?? '')
    : '';
  return flowDiff ? `${automationDiff}\n${flowDiff}` : automationDiff;
}

function EditorPage({ client, id, index, session, resolvedTheme }: { client: ManagerClient; id: string; index: AutomationIndex | null; session: SessionInfo; resolvedTheme: ResolvedTheme }) {
  const [bundleState, setBundleState] = useState<LoadState<AutomationBundle>>({ status: 'loading' });
  const [draft, setDraft] = useState<MonitorDraftState | null>(null);
  const [compose, setCompose] = useState<ComposeResult | null>(null);
  const [tab, setTab] = useState<EditorTab>(routeTab);
  const [status, setStatus] = useState('');
  const [conflict, setConflict] = useState<ErrorBody | null>(null);
  const [invalid, setInvalid] = useState<Problem[] | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [reviewBase, setReviewBase] = useState<AutomationBundle | null>(null);
  const [selection, setSelection] = useState<Selection>({ type: 'automation' });
  const [modelList, setModelList] = useState<ModelList>(session.modelList);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(true);

  const refreshModels = useCallback(() => {
    setModelsRefreshing(true);
    void client.refreshModels()
      .then(setModelList)
      .catch((error: unknown) => setModelList((current) => ({ ...current, error: error instanceof Error ? error.message : 'the server did not answer' })))
      .finally(() => setModelsRefreshing(false));
  }, [client]);

  const load = useCallback(() => {
    setBundleState({ status: 'loading' });
    setConflict(null);
    setInvalid(null);
    void client.bundle(id).then((bundle) => {
      setBundleState({ status: 'ready', value: bundle });
      setDraft(draftFromBundle(bundle));
      setCompose(null);
      setStatus('');
    }).catch((error: unknown) => setBundleState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load automation' }));
  }, [client, id]);

  useEffect(load, [load]);

  // A fresher run list from the Runs tab. Only the runs and whether one is going are taken from it:
  // the revisions a save is checked against stay the ones the draft was made from.
  const mergeRuns = useCallback((fresh: AutomationBundle) => {
    setBundleState((current) => current.status !== 'ready' ? current : {
      status: 'ready',
      value: {
        ...current.value,
        runs: fresh.runs,
        summary: { ...current.value.summary, running: fresh.summary.running, last: fresh.summary.last, recent: fresh.summary.recent },
      },
    });
  }, []);

  useEffect(() => {
    if (!draft) return undefined;
    const timer = window.setTimeout(() => {
      void client.compose(id, toMonitorDraft(draft)).then((result) => {
        setCompose(result);
        if (result.fields && draft.automationText !== undefined) setDraft((current) => current ? { ...current, fields: result.fields } : current);
      }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : 'Compose failed'));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [client, draft, id]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (draft?.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft?.dirty]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-am-save]')?.click();
      }
      if (event.key === 'Escape') setSelection({ type: 'automation' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (bundleState.status === 'loading' || !draft) return <main className="am-home"><p>Loading automation…</p></main>;
  if (bundleState.status === 'error') return <main className="am-home"><section className="am-banner am-banner--error">{bundleState.message}</section></main>;

  const bundle = bundleState.value;
  const allProblems = [...bundle.problems, ...(compose?.problems ?? [])];
  const save = (allowInvalid = false, overrideBundle = bundle) => {
    setStatus('Saving…');
    setConflict(null);
    setInvalid(null);
    void client.save(id, {
      ...toMonitorDraft(draft),
      base: { automation: overrideBundle.files.automation.revision, flow: overrideBundle.files.flow?.revision ?? null },
      allowInvalid,
    }).then((next) => {
      setBundleState({ status: 'ready', value: next });
      setDraft(draftFromBundle(next));
      setCompose(null);
      setStatus('Saved');
    }).catch((error: unknown) => {
      if (error instanceof ManagerError && error.status === 409) {
        setConflict(error.body ?? null);
        setBundleState({ status: 'ready', value: revisionFromError(error, bundle) });
        setStatus('Changed on disk');
      } else if (error instanceof ManagerError && error.status === 422) {
        setInvalid(error.body?.problems ?? allProblems);
        setStatus('Invalid draft');
      } else {
        setStatus(error instanceof Error ? error.message : 'Save failed');
      }
    });
  };

  const navigateTab = (next: EditorTab) => {
    setTab(next);
    window.history.replaceState(null, '', `/automations/${encodeURIComponent(id)}?tab=${next}`);
  };

  // Review compares the draft with what is on disk NOW (after a conflict that differs from what
  // was loaded), using a compose of the current draft rather than the last debounced one.
  const review = () => {
    void Promise.all([client.bundle(id), client.compose(id, toMonitorDraft(draft))])
      .then(([fresh, result]) => {
        setCompose(result);
        setReviewBase(fresh);
        setDiffOpen(true);
      })
      .catch(() => {
        setReviewBase(null);
        setDiffOpen(true);
      });
  };

  const diff = diffFor(reviewBase ?? bundle, draft, compose);

  return (
    <main className="am-editor">
      <Sidebar index={index} selected={id} />
      <section className="am-editor-main">
        <AutomationHeader bundle={bundle} dirty={draft.dirty} status={status} onSave={() => save(false)} onRevert={load} onReview={review} />
        <button type="button" hidden data-am-save onClick={() => save(false)}>Save</button>
        {conflict && <ConflictBanner onReload={load} onReview={review} onOverwrite={() => save(false, bundle)} />}
        {invalid && <InvalidBanner problems={invalid} onSaveAnyway={() => save(true)} />}
        <TabBar tab={tab} problems={allProblems.length} problemsOpen={problemsOpen} onToggleProblems={() => setProblemsOpen((open) => !open)} onChange={navigateTab} />
        <ProblemsPanel problems={allProblems} open={problemsOpen} />
        <div id="am-editor-panel" className="am-editor-content" role="tabpanel" aria-labelledby={`am-tab-${tab}`} tabIndex={0}>
          {tab === 'flow' && <FlowCanvas bundle={bundle} draft={draft} setDraft={setDraft} compose={compose} selection={selection} setSelection={setSelection} />}
          {tab === 'instructions' && <InstructionsTab draft={draft} setDraft={setDraft} />}
          {tab === 'files' && <FilesTab client={client} id={id} theme={resolvedTheme} onOpenSource={() => setTab('source')} />}
          {tab === 'runs' && <RunsTab bundle={bundle} client={client} id={id} onRuns={mergeRuns} initialRun={routeRun()} />}
          {tab === 'source' && <SourceTab bundle={bundle} draft={draft} setDraft={setDraft} compose={compose} theme={resolvedTheme} />}
        </div>
      </section>
      <Inspector draft={draft} setDraft={setDraft} compose={compose} problems={allProblems} models={{ list: modelList, refreshing: modelsRefreshing, refresh: refreshModels }} selection={selection} watchStatus={{ ...(bundle.summary.lastCheck ? { lastCheck: bundle.summary.lastCheck } : {}), ...(bundle.summary.nextCheck ? { nextCheck: bundle.summary.nextCheck } : {}) }} />
      <DiffDrawer diff={diff} open={diffOpen} onClose={() => { setDiffOpen(false); setReviewBase(null); }} />
    </main>
  );
}

export function MonitorApp({ session, theme, resolvedTheme, onCycleTheme }: MonitorAppProps) {
  const client = useMemo(() => new ManagerClient(session), [session]);
  const [indexState, setIndexState] = useState<LoadState<AutomationIndex>>({ status: 'loading' });
  const id = routeId();

  useEffect(() => {
    let active = true;
    const refresh = () => void client.automations().then((value) => active && setIndexState({ status: 'ready', value })).catch((error: unknown) => active && setIndexState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load automations' }));
    refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client]);

  return (
    <AppShell theme={theme} onCycleTheme={onCycleTheme} page={isHistoryRoute() ? 'history' : 'automations'}>
      {isHistoryRoute() ? (
        <HistoryPage client={client} index={indexState.status === 'ready' ? indexState.value : null} />
      ) : id ? (
        <EditorPage client={client} id={id} index={indexState.status === 'ready' ? indexState.value : null} session={session} resolvedTheme={resolvedTheme} />
      ) : indexState.status === 'ready' ? (
        <Home index={indexState.value} />
      ) : (
        <main className="am-home"><p>{indexState.status === 'error' ? indexState.message : 'Loading automations…'}</p></main>
      )}
    </AppShell>
  );
}
