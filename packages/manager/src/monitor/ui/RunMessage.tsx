import type { Outcome, RunLink, RunMessage, RunNote } from '../../host/contract';
import { formatAge } from './format';
import { MarkdownView, safeHref } from './MarkdownView';

/** What a run left for its reader: its own message, else its notes, else what it said. */
export interface ShownMessage {
  from: 'message' | 'notes' | 'reply';
  text: string;
  links: RunLink[];
  ts?: string;
}

export function shownMessage(run: {
  message?: RunMessage;
  notes?: RunNote[];
  outcome?: Outcome;
  output?: { text: string };
  error?: { message: string };
}): ShownMessage | undefined {
  if (run.message) return { from: 'message', text: run.message.text, links: uniqueLinks(run.message.links), ts: run.message.ts };
  const notes = run.notes ?? [];
  if (notes.length > 0) {
    return { from: 'notes', text: notes.map((n) => n.text.trim()).filter(Boolean).join('\n\n'), links: uniqueLinks(notes.flatMap((n) => n.links)) };
  }
  // Only what the run produced: a failure's error, else its output's lead line. Never a made-up summary.
  const reply = run.outcome === 'failed' ? run.error?.message.trim() : firstLine(run.output?.text);
  return reply ? { from: 'reply', text: reply, links: [] } : undefined;
}

function uniqueLinks(links: RunLink[]): RunLink[] {
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}

/** The first line a person would read, without Markdown's marks: `[text](url)` reads as text. */
export function firstLine(text: string | undefined): string | undefined {
  const line = (text ?? '')
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s*(#+|[-*+>]|\d+\.)\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|`)/g, '')
        .trim(),
    )
    .find(Boolean);
  return line || undefined;
}

/** Links as buttons. Anything that is not http(s) stays plain text. */
export function LinkChips({ links }: { links: RunLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="am-link-chips">
      {links.map((link) => {
        const href = safeHref(link.url);
        const label = link.label ?? link.url.replace(/^https?:\/\//, '');
        return href ? (
          <a key={link.url} className="am-link-chip" href={href} target="_blank" rel="noreferrer" title={link.url}>{label} ↗</a>
        ) : (
          <span key={link.url} className="am-link-chip am-link-chip--plain">{link.label ?? link.url}</span>
        );
      })}
    </div>
  );
}

/** The run's message, its links first-class; a run that left none shows its notes or its reply. */
export function MessageSection({ shown, notes, live = false }: { shown: ShownMessage | undefined; notes?: RunNote[]; live?: boolean }) {
  const title = live ? 'Message so far' : 'Message';
  return (
    <section className="am-run-section am-run-message" aria-label={title}>
      <h3>{title}</h3>
      {shown && shown.from !== 'message' && (
        <p className="am-muted am-run-message__from">{shown.from === 'notes' ? 'No message; these are its notes.' : 'No message; this is what it said.'}</p>
      )}
      {!shown ? (
        <p className="am-muted">{live ? 'No message yet.' : 'No message.'}</p>
      ) : shown.from === 'notes' && notes ? (
        <NotesList notes={notes} />
      ) : (
        <>
          <MarkdownView text={shown.text} />
          <LinkChips links={shown.links} />
        </>
      )}
    </section>
  );
}

export function NotesList({ notes }: { notes: RunNote[] }) {
  if (notes.length === 0) return <p className="am-muted">No notes.</p>;
  return (
    <ul className="am-run-notes">
      {notes.map((note, i) => (
        <li key={`${note.ts}-${i}`}>
          <time dateTime={note.ts} title={note.ts}>{formatAge(note.ts)}</time>
          <MarkdownView text={note.text} />
          {note.links.length > 0 && (
            <div className="am-run-links">
              {note.links.map((link) => {
                const href = safeHref(link.url);
                return href ? (
                  <a key={link.url} href={href} target="_blank" rel="noreferrer">{link.label ?? link.url} ↗</a>
                ) : (
                  <span key={link.url}>{link.label ?? link.url}</span>
                );
              })}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
