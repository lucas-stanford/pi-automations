/** Every user-facing error is one line: `<field path>: <what is wrong> — <what fixes it>`. */
export class AutomationError extends Error {
    field;
    fix;
    /** When one check finds several things wrong (a strict flow), each as its own line. */
    problems;
    constructor(field, fix, problems) {
        super(`${field}: ${fix}`);
        this.name = "AutomationError";
        this.field = field;
        this.fix = fix;
        if (problems)
            this.problems = problems;
    }
}
/** A model that cannot be resolved. Same one-line shape; a distinct type so callers can branch. */
export class ModelError extends AutomationError {
    constructor(field, fix) {
        super(field, fix);
        this.name = "ModelError";
    }
}
/** Collapse anything throwable into a single line fit for a listing or a run record. */
export function oneLine(e) {
    if (e instanceof AutomationError)
        return e.message;
    if (e instanceof Error) {
        const first = (e.message ?? "").split("\n")[0];
        return first && first.trim() ? first.trim() : e.name;
    }
    return String(e);
}
//# sourceMappingURL=errors.js.map