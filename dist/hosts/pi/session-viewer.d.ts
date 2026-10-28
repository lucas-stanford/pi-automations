import type { TranscriptReaders } from "../../ui/session-view.js";
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
export declare function createSessionViewer(options: SessionViewerOptions): SessionViewer;
