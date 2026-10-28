import type { PrepareWorkspace } from "../core/contracts.js";
/** A bounded excerpt of git's error, preferring its `fatal:`/`error:` line. */
export declare function workspaceFailureDetail(e: unknown): string;
/** The local workspace provider: a failed worktree is a typed failure, never a fallback. */
export declare const prepareLocalWorkspace: PrepareWorkspace;
