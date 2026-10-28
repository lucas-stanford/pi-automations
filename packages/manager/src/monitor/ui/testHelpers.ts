import type { AutomationBundle, AutomationFields, AutomationSummary, ComposeResult, ModelList } from '../../host/contract';
import { draftFromBundle } from '../draft';
import type { ModelChoices } from './ModelField';

export function sampleFields(overrides: Partial<AutomationFields> = {}): AutomationFields {
  return {
    name: 'flow-example',
    description: 'Coordinate status-note subagents.',
    enabled: true,
    model: 'anthropic/claude-sonnet-4-5:low',
    timeout: '10m',
    on: { manual: true, schedule: { cron: '0 9 * * 1-5', timezone: 'America/Los_Angeles', catchUp: 'skip' } },
    hooks: { pre: [{ script: 'prepare.js' }, { prompt: 'Collect context' }], post: [{ script: 'save.js' }] },
    body: 'Run the automation.',
    ...overrides,
  };
}

export function sampleModelList(overrides: Partial<ModelList> = {}): ModelList {
  return {
    models: [
      { value: 'anthropic/claude-opus-4-1', name: 'Claude Opus 4.1', source: 'enabled' },
      { value: 'anthropic/claude-sonnet-4-5:low', source: 'automation' },
      { value: 'openai/gpt-5', name: 'GPT-5', source: 'available' },
    ],
    readAt: '2026-09-29T18:00:00.000Z',
    ...overrides,
  };
}

export function sampleModelChoices(overrides: Partial<ModelChoices> = {}): ModelChoices {
  return { list: sampleModelList(), refreshing: false, refresh: () => undefined, ...overrides };
}

export function sampleSummary(fields = sampleFields(), flow = true): AutomationSummary {
  return {
    id: `${fields.name}.12345678`,
    key: `user:/tmp:${fields.name}`,
    name: fields.name,
    scope: 'user',
    rootLabel: '~/.agents/automations',
    dir: `~/.agents/automations/${fields.name}`,
    state: fields.enabled ? 'armed' : 'disabled',
    description: fields.description,
    triggers: fields.on,
    tracked: flow,
    hasFlowFile: flow,
    editable: true,
    recent: ['ok', 'failed', 'ok'],
  };
}

export function sampleBundle(fields = sampleFields(), flowText: string | null = 'flowchart TD\n  pre0["Prepare"] --> pre1["Collect"]\n  pre1 --> body["Body"]\n  body --> post0["Save"]\n'): AutomationBundle {
  return {
    summary: sampleSummary(fields, Boolean(flowText)),
    fields,
    files: {
      automation: { text: 'automation', revision: 'sha256:a', bytes: 10, updatedAt: null },
      flow: flowText == null ? null : { text: flowText, revision: 'sha256:f', bytes: flowText.length, updatedAt: null },
    },
    flow: {
      source: flowText ? 'file' : 'none',
      text: flowText,
      generated: 'flowchart TD\n  body["Body"]\n',
      driven: [...fields.hooks.pre.map((_, index) => `pre${index}`), 'body', ...fields.hooks.post.map((_, index) => `post${index}`)],
    },
    problems: [],
    nextFires: [],
    runs: [],
    notices: [],
  };
}

export function sampleDraft(fields = sampleFields(), flowText?: string | null) {
  return draftFromBundle(sampleBundle(fields, flowText));
}

export function sampleCompose(fields = sampleFields()): ComposeResult {
  return {
    automationText: 'automation',
    flowText: null,
    flowFileText: null,
    fields,
    valid: true,
    problems: [],
    nextFires: ['2026-09-25T16:00:00.000Z', '2026-09-26T16:00:00.000Z', '2026-09-27T16:00:00.000Z'],
    generatedFlow: null,
    driven: ['pre0', 'pre1', 'body', 'post0'],
    changed: { automation: false, flow: false },
  };
}
