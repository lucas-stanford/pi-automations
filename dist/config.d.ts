import type { Config, ConfigDurationField } from "./types.js";
export declare const DEFAULTS: Config;
/** The one plugin known by name: the Automation Manager, shipped in `packages/manager`. */
export declare const BUNDLED_PLUGINS: readonly ["manager"];
/** Read config.json: the effective config plus one warning per rejected value. */
export declare function loadConfig(dir?: string): {
    config: Config;
    warnings: string[];
};
/** A duration field in milliseconds. The fallback only fires for a hand-built Config. */
export declare function ms(config: Config, field: ConfigDurationField): number;
