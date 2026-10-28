import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import YAML from 'yaml';

const root = resolve(process.cwd());
const fixtureDir = join(root, 'e2e', 'fixtures');
const dataDir = join(root, 'e2e', '.mock-data');
const distDir = join(root, 'dist');
const token = 'mock-token';
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'";

function hash(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function parseAutomation(text, fallbackName) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const data = YAML.parse(match[1]) ?? {};
  return {
    name: String(data.name ?? fallbackName),
    description: String(data.description ?? ''),
    enabled: data.enabled !== false,
    ...(data.model ? { model: String(data.model) } : {}),
    ...(data.timeout ? { timeout: String(data.timeout) } : {}),
    on: { manual: data.on?.manual === true, ...(data.on?.schedule ? { schedule: { cron: String(data.on.schedule.cron ?? ''), ...(data.on.schedule.timezone ? { timezone: String(data.on.schedule.timezone) } : {}), catchUp: data.on.schedule['catch-up'] === 'once' ? 'once' : 'skip' } } : {}), ...(data.on?.watch ? { watch: { script: String(data.on.watch.script ?? ''), every: String(data.on.watch.every ?? '') } } : {}) },
    hooks: { pre: Array.isArray(data.hooks?.pre) ? data.hooks.pre : [], post: Array.isArray(data.hooks?.post) ? data.hooks.post : [] },
    body: match[2].trim(),
  };
}

function composeAutomation(fields) {
  const data = {
    name: fields.name,
    description: fields.description,
    enabled: fields.enabled,
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.timeout ? { timeout: fields.timeout } : {}),
    on: { manual: fields.on.manual, ...(fields.on.schedule ? { schedule: { cron: fields.on.schedule.cron, ...(fields.on.schedule.timezone ? { timezone: fields.on.schedule.timezone } : {}), 'catch-up': fields.on.schedule.catchUp } } : {}), ...(fields.on.watch ? { watch: fields.on.watch } : {}) },
    hooks: fields.hooks,
  };
  return `---\n${YAML.stringify(data)}---\n${fields.body.trim()}\n`;
}

function mermaidBlock(text) {
  const match = text.match(/(^|\r?\n)```mermaid\r?\n([\s\S]*?)\r?\n```/);
  return match ? { full: match[0], text: `${match[2].trim()}\n` } : null;
}

function writeAutomationChart(automationText, flowText) {
  const block = mermaidBlock(automationText);
  if (flowText === null) return block ? automationText.replace(block.full, block.full.startsWith('\n') ? '\n' : '') : automationText;
  const nextBlock = `\n\n\`\`\`mermaid\n${flowText.trim()}\n\`\`\``;
  if (block) return automationText.replace(block.full, nextBlock);
  const frontmatter = automationText.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!frontmatter) return `${automationText.trimEnd()}${nextBlock}\n`;
  const body = frontmatter[2];
  const heading = body.match(/^(# .*(?:\r?\n|$))/);
  if (heading) {
    return `${frontmatter[1]}${heading[1].trimEnd()}${nextBlock}\n${body.slice(heading[0].length).replace(/^\r?\n/, '')}`;
  }
  return `${frontmatter[1]}${nextBlock.trimStart()}\n\n${body.replace(/^\r?\n/, '')}`;
}

function generatedFlow(fields) {
  const nodes = [];
  fields.hooks.pre.forEach((hook, index) => nodes.push(`pre${index}["pre[${index}] ${hook.script ?? 'prompt'}"]`));
  nodes.push(`body["${fields.name}"]`);
  fields.hooks.post.forEach((hook, index) => nodes.push(`post${index}["post[${index}] ${hook.script ?? 'prompt'}"]`));
  const lines = ['flowchart TD'];
  if (nodes.length === 1) lines.push(`  ${nodes[0]}`);
  else for (let i = 0; i < nodes.length - 1; i += 1) lines.push(`  ${nodes[i]} --> ${nodes[i + 1]}`);
  return `${lines.join('\n')}\n`;
}

async function textFile(path) {
  return readFile(path, 'utf8');
}

function idFor(name) {
  return `${name}.${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

async function names() {
  return (await readdir(dataDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** The automation the mock says is running, so the Runs tab follows a live run. */
const LIVE = 'issue-triage';
const liveStartedAt = new Date(Date.now() - 90_000).toISOString();

/** The ids of a chart's nodes and its edges, read the simple way: enough for the fixtures. */
function chartShape(text) {
  const nodes = new Map();
  const edges = [];
  for (const raw of (text ?? '').split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    const parts = line.split(/\s*-->(?:\|[^|]*\|)?\s*/);
    const ids = parts.map((part) => {
      const m = part.match(/^([A-Za-z0-9_-]+)(?:\[\"?([^\]\"]*)\"?\])?/);
      if (!m) return null;
      if (!nodes.has(m[1]) || m[2]) nodes.set(m[1], m[2] ?? nodes.get(m[1]) ?? m[1]);
      return m[1];
    }).filter(Boolean);
    for (let i = 0; i < ids.length - 1; i += 1) edges.push([ids[i], ids[i + 1]]);
  }
  return { nodes: [...nodes].map(([id, label]) => ({ id, label })), edges };
}

/** A finished run on its chart: every node reached, one note with a link. */
function finishedRun(name, fields, chartText) {
  const shape = chartShape(chartText);
  return {
    id: `${name}-run`, trigger: 'manual', outcome: 'ok', recordedAt: new Date().toISOString(),
    startedAt: new Date(Date.now() - 1200).toISOString(), endedAt: new Date().toISOString(), durationMs: 1200,
    model: fields?.model, summary: `Completed ${name}`, output: { text: `# ${name}\nDone`, truncated: false }, hooks: [],
    ...(chartText ? {
      chart: chartText,
      steps: shape.nodes.map((n) => ({ id: n.id, label: n.label, status: 'done', ...(n.id === 'compose' ? { text: 'Status note ready' } : {}) })),
      taken: shape.edges,
    } : {}),
    notes: [{ ts: new Date(Date.now() - 600).toISOString(), text: `Saved the **status note** for ${name}.`, links: [{ label: 'status note', url: `https://example.com/notes/${name}` }] }],
    ...(MESSAGES[name] ? { message: { ts: new Date(Date.now() - 300).toISOString(), ...MESSAGES[name] } } : {}),
  };
}

/** What some fixtures' last runs left for their reader. */
const MESSAGES = {
  'daily-digest': {
    text: 'Digest is up: **2 PRs** wait on you — #11911 needs a re-review and #11920 has a failing check. Nothing else moved overnight.',
    links: [
      { label: 'Canvas digest', url: 'https://example.com/digest/2026-10-22' },
      { label: 'PR #11911', url: 'https://github.com/example/app/pull/11911' },
      { label: 'PR #11920', url: 'https://github.com/example/app/pull/11920' },
    ],
  },
  'pr-review': {
    text: 'Replied to 4 review threads: fixed 2 defects, declined 2 nits with reasons. One question needs your call.',
    links: [{ label: 'The question', url: 'https://github.com/example/app/pull/11888#discussion_r1' }, { label: 'PR #11888', url: 'https://github.com/example/app/pull/11888' }],
  },
};

/** Older runs, for History: a failure, a skip and a run that left only notes. */
function olderRuns(name, index) {
  const at = (hours) => new Date(Date.now() - hours * 3600_000 - index * 600_000).toISOString();
  return [
    { id: `${name}-older-1`, trigger: 'schedule', outcome: index % 2 ? 'failed' : 'ok', recordedAt: at(5), startedAt: at(5.02), endedAt: at(5), durationMs: 72_000, summary: index % 2 ? 'gh: HTTP 502 while posting the report' : `Checked ${name}: nothing new`, ...(index % 2 ? { error: { kind: 'agent', message: 'gh: HTTP 502 while posting the report' } } : { output: { text: `Checked ${name}: nothing new`, truncated: false } }), hooks: [] },
    { id: `${name}-older-2`, trigger: 'schedule', outcome: 'skipped', reason: 'nothing new', recordedAt: at(26), summary: 'skipped: nothing new', hooks: [] },
  ];
}

async function history(url) {
  const all = [];
  for (const name of await names()) {
    const bundle = await bundleFor(name);
    for (const run of bundle.runs) all.push({ ...run, automation: { id: bundle.summary.id, name } });
  }
  const automation = url.searchParams.get('automation');
  const outcome = url.searchParams.get('outcome');
  const message = url.searchParams.get('message') === '1';
  const limit = Number(url.searchParams.get('limit') ?? 200);
  const runs = all
    .filter((r) => (!automation || r.automation.id === automation) && (!outcome || r.outcome === outcome) && (!message || r.message || r.notes?.length))
    .sort((a, b) => Date.parse(b.endedAt ?? b.recordedAt) - Date.parse(a.endedAt ?? a.recordedAt));
  return { runs: runs.slice(0, limit), limit, more: runs.length > limit };
}

/** Where the live run is: the first node done, the second going. */
function liveProgress(name, chartText) {
  const shape = chartShape(chartText);
  return {
    runId: `${name}-live`, key: `user:${dataDir}:${name}`, name, chart: chartText ?? '',
    steps: shape.nodes.map((n, i) => ({ id: n.id, label: n.label, status: i === 0 ? 'done' : i === 1 ? 'active' : 'pending', ...(i === 1 ? { text: 'Reading the issue thread' } : {}) })),
    taken: shape.edges.slice(0, 1),
    notes: [{ ts: new Date(Date.now() - 30_000).toISOString(), text: 'Commented on issue 12.', links: [{ label: 'issue 12', url: 'https://github.com/example/app/issues/12' }] }],
    closed: false,
  };
}

function summaryFrom(name, fields, hasFlow) {
  return {
    id: idFor(name), key: `user:${dataDir}:${name}`, name, scope: 'user', rootLabel: '~/.agents/automations', dir: `~/.agents/automations/${name}`,
    state: fields.enabled ? 'armed' : 'disabled', description: fields.description, triggers: fields.on, nextFire: fields.on.schedule ? new Date(Date.now() + 3600_000).toISOString() : undefined,
    tracked: hasFlow, hasFlowFile: hasFlow, editable: true,
    ...(name === LIVE ? { running: { runId: `${name}-live`, pid: 4242, startedAt: liveStartedAt } } : {}),
    last: { outcome: 'ok', at: new Date(Date.now() - 600_000).toISOString(), durationMs: 1200 }, recent: ['ok', 'ok', 'skipped', 'failed', 'ok'],
  };
}

async function bundleFor(idOrName) {
  const name = (await names()).find((item) => idFor(item) === idOrName || item === idOrName || idOrName.startsWith(`${item}.`));
  if (!name) return null;
  const dir = join(dataDir, name);
  const automationText = await textFile(join(dir, 'AUTOMATION.md'));
  const fields = parseAutomation(automationText, name);
  const flowPath = join(dir, 'flow.mmd');
  const hasFlow = existsSync(flowPath);
  const flowText = hasFlow ? await textFile(flowPath) : null;
  const automationFlow = mermaidBlock(automationText)?.text ?? null;
  const chartText = automationFlow ?? flowText;
  const generated = fields ? generatedFlow(fields) : null;
  return {
    summary: summaryFrom(name, fields, Boolean(chartText)), fields,
    files: { automation: { text: automationText, revision: hash(automationText), bytes: Buffer.byteLength(automationText), updatedAt: new Date().toISOString() }, flow: flowText == null ? null : { text: flowText, revision: hash(flowText), bytes: Buffer.byteLength(flowText), updatedAt: new Date().toISOString() } },
    flow: { source: automationFlow ? 'automation' : hasFlow ? 'file' : 'none', text: chartText, generated, driven: fields ? [...fields.hooks.pre.map((_, i) => `pre${i}`), 'body', ...fields.hooks.post.map((_, i) => `post${i}`)] : [] },
    problems: [], nextFires: fields?.on.schedule ? [new Date(Date.now() + 3600_000).toISOString()] : [],
    runs: [finishedRun(name, fields, chartText), ...olderRuns(name, (await names()).indexOf(name))],
    notices: [],
  };
}

async function index() {
  const automations = [];
  for (const name of await names()) {
    const bundle = await bundleFor(name);
    automations.push(bundle.summary);
  }
  return { groups: [{ id: 'user', scope: 'user', title: 'USER · ~/.agents/automations', rootLabel: '~/.agents/automations', automations }], generatedAt: new Date().toISOString() };
}

async function json(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Security-Policy': csp, ...headers });
  res.end(JSON.stringify(body));
}

async function listFiles(name) {
  const dir = join(dataDir, name);
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = entry.name;
    const s = await stat(join(dir, path));
    entries.push({ name: entry.name, path, kind: entry.isDirectory() ? 'dir' : 'file', bytes: entry.isDirectory() ? 0 : s.size, updatedAt: s.mtime.toISOString(), role: path === 'AUTOMATION.md' ? 'automation' : path === 'flow.mmd' ? 'flow' : undefined });
  }
  return { path: '', entries: entries.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name)), skipped: [] };
}

function language(path) {
  const ext = extname(path).toLowerCase();
  return ext === '.md' ? 'markdown' : ext === '.mmd' ? 'mermaid' : ext === '.js' ? 'javascript' : ext === '.json' ? 'json' : ext === '.yml' || ext === '.yaml' ? 'yaml' : ext === '.toml' ? 'toml' : 'text';
}

async function startMockServer({ port = 0 } = {}) {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await cp(fixtureDir, dataDir, { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/session') return send(res, 200, { kind: 'automation-manager', apiVersion: 2, version: 'mock', token, stateDir: '~/.pi/agent/pi-automations', modelList: { models: [{ value: 'anthropic/claude-sonnet-4-5:low', source: 'automation' }, { value: 'anthropic/claude-haiku-4-5', source: 'available' }], readAt: null }, limits: { maxFileBytes: 1048576, maxRequestBytes: 4194304 } });
      if (url.pathname === '/api/automations') return send(res, 200, await index());
      if (url.pathname === '/api/history') return send(res, 200, await history(url));
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api' && parts[1] === 'automations' && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        const bundle = await bundleFor(id);
        if (!bundle) return send(res, 404, { error: 'not found', code: 'not-found' });
        const name = bundle.summary.name;
        if (parts.length === 3 && req.method === 'GET') return send(res, 200, bundle);
        if (parts.length === 6 && parts[3] === 'runs' && parts[5] === 'progress') {
          return name === LIVE && parts[4] === `${name}-live`
            ? send(res, 200, liveProgress(name, bundle.flow.text))
            : send(res, 404, { error: 'that run is not going', code: 'not-found' });
        }
        if (parts[3] === 'compose' && req.method === 'POST') {
          const draft = await json(req);
          const fields = draft.automationText ? parseAutomation(draft.automationText, name) : (draft.fields ?? bundle.fields);
          let automationText = draft.automationText ?? composeAutomation(fields);
          const sendsFlow = Object.hasOwn(draft, 'flowText');
          if (sendsFlow) automationText = writeAutomationChart(automationText, draft.flowText);
          const flowText = sendsFlow ? draft.flowText : bundle.flow.text;
          const flowFileText = sendsFlow ? null : bundle.files.flow?.text ?? null;
          return send(res, 200, { automationText, flowText, flowFileText, fields, valid: Boolean(fields), problems: fields ? [] : [{ file: 'AUTOMATION.md', severity: 'error', message: 'frontmatter: invalid' }], nextFires: bundle.nextFires, generatedFlow: fields ? generatedFlow(fields) : null, driven: fields ? [...fields.hooks.pre.map((_, i) => `pre${i}`), 'body', ...fields.hooks.post.map((_, i) => `post${i}`)] : [], changed: { automation: automationText !== bundle.files.automation.text, flow: flowFileText !== (bundle.files.flow?.text ?? null) } });
        }
        if (parts.length === 3 && req.method === 'PUT') {
          const draft = await json(req);
          const currentAutomation = await textFile(join(dataDir, name, 'AUTOMATION.md'));
          const currentFlowPath = join(dataDir, name, 'flow.mmd');
          const currentFlow = existsSync(currentFlowPath) ? await textFile(currentFlowPath) : null;
          if (draft.base && (draft.base.automation !== hash(currentAutomation) || draft.base.flow !== (currentFlow == null ? null : hash(currentFlow)))) {
            return send(res, 409, { error: 'changed on disk', code: 'conflict', current: { automation: hash(currentAutomation), flow: currentFlow == null ? null : hash(currentFlow) } });
          }
          const fields = draft.automationText ? parseAutomation(draft.automationText, name) : (draft.fields ?? bundle.fields);
          if (!fields && !draft.allowInvalid) return send(res, 422, { error: 'invalid', code: 'invalid', problems: [{ file: 'AUTOMATION.md', severity: 'error', message: 'frontmatter: invalid' }] });
          let automationText = draft.automationText ?? composeAutomation(fields);
          if (Object.hasOwn(draft, 'flowText')) {
            automationText = writeAutomationChart(automationText, draft.flowText);
            await rm(join(dataDir, name, 'flow.mmd'), { force: true });
          }
          await writeFile(join(dataDir, name, 'AUTOMATION.md'), automationText, 'utf8');
          return send(res, 200, await bundleFor(name));
        }
        if (parts[3] === 'files') return send(res, 200, await listFiles(name));
        if (parts[3] === 'file') {
          const path = url.searchParams.get('path') ?? '';
          const file = join(dataDir, name, path);
          if (req.method === 'GET') {
            const text = await textFile(file);
            return send(res, 200, { path, text, bom: false, revision: hash(text), bytes: Buffer.byteLength(text), updatedAt: new Date().toISOString(), language: language(path), role: path === 'AUTOMATION.md' ? 'automation' : path === 'flow.mmd' ? 'flow' : undefined });
          }
          if (req.method === 'PUT') {
            const body = await json(req);
            const current = existsSync(file) ? await textFile(file) : null;
            if (body.base !== (current == null ? null : hash(current))) {
              return send(res, 409, { error: 'changed on disk', code: 'conflict', current: { file: current == null ? null : hash(current) } });
            }
            await writeFile(file, body.text, 'utf8');
            const text = await textFile(file);
            return send(res, 200, { file: { path, text, bom: Boolean(body.bom), revision: hash(text), bytes: Buffer.byteLength(text), updatedAt: new Date().toISOString(), language: language(path) }, summary: (await bundleFor(name)).summary });
          }
        }
      }
      const asset = url.pathname === '/' || url.pathname.startsWith('/automations/') || !extname(url.pathname) ? join(distDir, 'index.html') : join(distDir, decodeURIComponent(url.pathname));
      if (!asset.startsWith(distDir) || !existsSync(asset)) return send(res, 404, { error: 'not found', code: 'not-found' });
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[extname(asset)] ?? 'application/octet-stream', 'Content-Security-Policy': csp });
      createReadStream(asset).pipe(res);
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : 'internal', code: 'internal' });
    }
  });
  await new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, dataDir };
}

export { startMockServer };

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const mock = await startMockServer({ port: Number(process.env.PORT || 0) });
  console.log(mock.url);
}
