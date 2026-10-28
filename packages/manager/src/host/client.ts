import {
  API_VERSION,
  MANAGER_KIND,
  TOKEN_HEADER,
  type AutomationBundle,
  type AutomationIndex,
  type ComposeRequest,
  type ComposeResult,
  type ErrorBody,
  type FileContent,
  type FileListing,
  type FileWriteRequest,
  type FileWriteResult,
  type HistoryPage,
  type LiveProgress,
  type ModelList,
  type Outcome,
  type SaveRequest,
  type SessionInfo,
} from './contract';

type ErrorKind = 'network' | 'timeout' | 'http' | 'api-version';

export class ManagerError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly body?: ErrorBody;

  constructor(message: string, options: { kind: ErrorKind; status?: number; body?: ErrorBody }) {
    super(message);
    this.name = 'ManagerError';
    this.kind = options.kind;
    this.status = options.status;
    this.body = options.body;
  }
}

async function parseError(response: Response): Promise<ErrorBody> {
  try {
    const parsed = (await response.json()) as Partial<ErrorBody>;
    if (typeof parsed.error === 'string' && typeof parsed.code === 'string') {
      return parsed as ErrorBody;
    }
  } catch {
    // not JSON
  }
  return { error: `${response.status} ${response.statusText}`, code: 'internal' };
}

function encodePath(path: string): string {
  return encodeURIComponent(path).replaceAll('%2F', '/');
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await parseError(response);
      throw new ManagerError(body.error, { kind: 'http', status: response.status, body });
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ManagerError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ManagerError('The Automation Manager did not answer in time.', { kind: 'timeout' });
    }
    throw new ManagerError(error instanceof Error ? error.message : 'Network request failed.', { kind: 'network' });
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

export async function probeSession(): Promise<SessionInfo | null> {
  try {
    const session = await fetchJson<SessionInfo>('/api/session', {}, 1500);
    if (session.kind !== MANAGER_KIND) return null;
    if (session.apiVersion !== API_VERSION) {
      throw new ManagerError(
        `Unsupported Automation Manager API ${session.apiVersion}; this build needs ${API_VERSION}.`,
        { kind: 'api-version' },
      );
    }
    return session;
  } catch (error) {
    if (error instanceof ManagerError && error.kind === 'api-version') throw error;
    return null;
  }
}

export class ManagerClient {
  readonly session: SessionInfo;

  constructor(session: SessionInfo) {
    this.session = session;
  }

  automations(): Promise<AutomationIndex> {
    return fetchJson('/api/automations');
  }

  /** Every automation's runs, newest first. */
  history(query: { automation?: string; outcome?: Outcome; message?: boolean; limit?: number } = {}): Promise<HistoryPage> {
    const params = new URLSearchParams();
    if (query.automation) params.set('automation', query.automation);
    if (query.outcome) params.set('outcome', query.outcome);
    if (query.message) params.set('message', '1');
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.toString();
    return fetchJson(`/api/history${search ? `?${search}` : ''}`);
  }

  /** Ask the server to read pi's models again. */
  refreshModels(): Promise<ModelList> {
    return this.write('/api/models/refresh', 'POST', {});
  }

  bundle(id: string): Promise<AutomationBundle> {
    return fetchJson(`/api/automations/${encodeURIComponent(id)}`);
  }

  compose(id: string, draft: ComposeRequest): Promise<ComposeResult> {
    return this.write(`/api/automations/${encodeURIComponent(id)}/compose`, 'POST', draft);
  }

  save(id: string, request: SaveRequest): Promise<AutomationBundle> {
    return this.write(`/api/automations/${encodeURIComponent(id)}`, 'PUT', request);
  }

  files(id: string, path = ''): Promise<FileListing> {
    return fetchJson(`/api/automations/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`);
  }

  file(id: string, path: string): Promise<FileContent> {
    return fetchJson(`/api/automations/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
  }

  /** Where a running run is now. Rejects with a 404 once it has ended. */
  progress(id: string, runId: string): Promise<LiveProgress> {
    return fetchJson(`/api/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/progress`);
  }

  writeFile(id: string, path: string, request: FileWriteRequest): Promise<FileWriteResult> {
    return this.write(`/api/automations/${encodeURIComponent(id)}/file?path=${encodePath(path)}`, 'PUT', request);
  }

  private write<T>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
    return fetchJson<T>(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        [TOKEN_HEADER]: this.session.token,
      },
      body: JSON.stringify(body),
    });
  }
}
