import { SECRET_NAME } from "../hooks.js";
/** Never written into a job file, nor passed to a hook. */
export { SECRET_NAME };
export interface EnvSnapshot {
    vars: Record<string, string>;
    /** Names that were present but deliberately left out. */
    refused: string[];
}
/** The subset of the current environment a job should carry (an allow-list). */
export declare function snapshotEnv(source?: NodeJS.ProcessEnv): EnvSnapshot;
/** Assert that no value in a rendered job file looks like a credential. */
export declare function assertNoSecrets(text: string, source?: NodeJS.ProcessEnv): void;
