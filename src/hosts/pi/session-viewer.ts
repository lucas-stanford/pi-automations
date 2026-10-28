// The session pane: one tail per transcript file, kept between renders.

import type { TranscriptReaders } from "../../ui/session-view.js";
import {
  buildSessionLines,
  decodeTranscript,
  unsupportedFormatLines,
} from "../../ui/session-view.js";
import { collapseSessionLines, type SessionLine } from "../../transcript-lines.js";
import { newTail, readTail, type TailState } from "../../tail.js";
import type { LineTheme } from "../../ui/theme.js";
import type { SessionReference } from "../../types.js";

export interface SessionSource {
  /** The file being written right now, when the run is still going. */
  readonly live?: string;
  /** The durable transcript, and the only one carrying a format tag. */
  readonly session?: SessionReference;
}

export interface SessionPaneRequest {
  readonly source: SessionSource;
  readonly width: number;
  readonly theme?: LineTheme;
}

export interface SessionViewerOptions {
  /** The decoders this host composed. A format nobody here can read is reported, not guessed. */
  readonly readers: TranscriptReaders;
  /** Bounded, so a long run cannot grow a tail without limit. */
  readonly linesKept?: number;
}

export interface SessionViewer {
  pane(request: SessionPaneRequest): string[] | undefined;
  /** How many files are being followed. For tests and for the disposal assertion. */
  readonly following: number;
  /** Stop reading. Nothing that is being read is affected. */
  dispose(): void;
}

const DEFAULT_LINES_KEPT = 500;

export function createSessionViewer(options: SessionViewerOptions): SessionViewer {
  const kept = options.linesKept ?? DEFAULT_LINES_KEPT;
  const tails = new Map<string, { tail: TailState; lines: SessionLine[] }>();
  let disposed = false;

  return {
    get following() {
      return tails.size;
    },

    dispose() {
      disposed = true;
      tails.clear();
    },

    pane(request: SessionPaneRequest): string[] | undefined {
      if (disposed) return undefined;

      const { live, session } = request.source;
      // The live file is always core's own shape; only the durable session reference carries a tag.
      const file = live ?? session?.file;
      const reference = live ? undefined : session;

      // Check the format first, so an unreadable transcript never looks merely empty.
      if (reference?.format) {
        const probe = decodeTranscript("", reference, options.readers);
        if (!probe.ok) return unsupportedFormatLines(probe.unsupported, request.width, request.theme);
      }

      if (!file) return undefined;

      let entry = tails.get(file);
      if (!entry) {
        entry = { tail: newTail(), lines: [] };
        tails.set(file, entry);
      }

      try {
        const r = readTail(file, entry.tail);
        if (r.restarted) entry.lines = [];
        if (r.text !== "") {
          // Collapse across reads too: a draft and its settled form can arrive in different reads.
          const read = decodeTranscript(r.text, reference, options.readers);
          if (!read.ok) {
            return unsupportedFormatLines(read.unsupported, request.width, request.theme);
          }
          entry.lines = collapseSessionLines([...entry.lines, ...read.parsed.lines]);
          if (entry.lines.length > kept) entry.lines = entry.lines.slice(-kept);
        }
      } catch {
        // Reading a view must never break the window showing it.
      }

      return buildSessionLines(entry.lines, {
        width: request.width,
        ...(request.theme ? { theme: request.theme } : {}),
        // Show reasoning so the pane is not blank while the model thinks.
        showThinking: true,
      });
    },
  };
}
