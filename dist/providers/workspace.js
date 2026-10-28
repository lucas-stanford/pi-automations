// Where a run's body runs: a directory, or a throwaway git worktree when opted in.
import { clipLine } from "../summary.js";
import { oneLine } from "../errors.js";
/** A bounded excerpt of git's error, preferring its `fatal:`/`error:` line. */
export function workspaceFailureDetail(e) {
    const err = e;
    let raw = "";
    if (typeof err?.stderr === "string") {
        raw = err.stderr;
    }
    else if (err?.stderr instanceof Buffer) {
        raw = err.stderr.toString("utf8");
    }
    const lines = raw
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    const diagnosis = lines.find((s) => /^(fatal|error):/i.test(s));
    return clipLine(diagnosis ?? lines[0] ?? oneLine(e), 160);
}
/** An ordinary directory. Releasing it does nothing, because we did not create it. */
function plainWorkspace(cwd) {
    return {
        cwd,
        async release() {
            // Nothing to release. The checkout was here before the run and stays after it.
        },
    };
}
/** The local workspace provider: a failed worktree is a typed failure, never a fallback. */
export const prepareLocalWorkspace = async (request) => {
    if (!request.isolated || !request.repositoryRoot) {
        return { ok: true, workspace: plainWorkspace(request.baseCwd) };
    }
    const repositoryRoot = request.repositoryRoot;
    let dir;
    try {
        const { execFileSync } = await import("node:child_process");
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const nodePath = await import("node:path");
        dir = mkdtempSync(nodePath.join(tmpdir(), "pi-automations-wt-"));
        execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], {
            cwd: repositoryRoot,
            // Keep stderr: it tells a path collision from a broken repository.
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        const created = dir;
        return {
            ok: true,
            workspace: {
                cwd: created,
                async release() {
                    try {
                        const { execFileSync: exec } = await import("node:child_process");
                        exec("git", ["worktree", "remove", "--force", created], {
                            cwd: repositoryRoot,
                            stdio: "ignore",
                            windowsHide: true,
                        });
                    }
                    catch {
                        // A leftover worktree is untidy, not dangerous; never throw from release.
                    }
                },
            },
        };
    }
    catch (e) {
        const detail = workspaceFailureDetail(e);
        if (dir !== undefined) {
            try {
                const { rmSync } = await import("node:fs");
                rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // Keep the primary error. A leftover empty temp directory is untidy, not dangerous.
            }
        }
        return {
            ok: false,
            failure: {
                kind: "workspace-preparation",
                repository: repositoryRoot,
                ...(dir !== undefined ? { intendedPath: dir } : {}),
                detail,
            },
        };
    }
};
//# sourceMappingURL=workspace.js.map