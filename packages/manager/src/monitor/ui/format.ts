import cronstrue from 'cronstrue';
import type { AutomationSummary, ScheduleFields, WatchCheckInfo, WatchFields } from '../../host/contract';

export function formatAge(iso?: string | null): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatFuture(iso?: string): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const seconds = Math.max(0, Math.floor((time - Date.now()) / 1000));
  if (seconds < 60) return 'in <1m';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function scheduleText(schedule?: ScheduleFields, manual?: boolean): string {
  if (!schedule) return manual ? 'manual' : 'no trigger';
  try {
    return `${cronstrue.toString(schedule.cron)}${schedule.timezone ? ` · ${schedule.timezone}` : ''}`;
  } catch {
    return `${schedule.cron}${schedule.timezone ? ` · ${schedule.timezone}` : ''}`;
  }
}

/** `checks every 5m`: a watch says how often it looks, because that is not how often it runs. */
function watchText(watch?: WatchFields): string {
  return watch ? `checks every ${watch.every}` : '';
}

export function summarySchedule(summary: AutomationSummary): string {
  const triggers = summary.triggers;
  const parts: string[] = [];
  if (triggers?.schedule) parts.push(scheduleText(triggers.schedule, false));
  if (triggers?.watch) parts.push(watchText(triggers.watch));
  if (parts.length === 0) return scheduleText(undefined, triggers?.manual);
  return parts.join(' · ');
}

/** `next check in 3m`, for a watch-only automation that has no next run to show. */
export function nextText(summary: AutomationSummary): string | null {
  if (summary.nextFire) return `next ${formatFuture(summary.nextFire)}`;
  if (summary.nextCheck) return `next check ${formatFuture(summary.nextCheck)}`;
  return null;
}

/** One line about a watch's last check: when, how it ended, and what it said. */
export function lastCheckText(check?: WatchCheckInfo): string {
  if (!check) return 'Not checked yet. Checks run while it is armed and the watcher is on (pa watcher start).';
  const ended = check.problem ?? `exit ${check.exit}`;
  return [`Checked ${formatAge(check.checkedAt)}`, ended, check.said].filter(Boolean).join(' · ');
}

