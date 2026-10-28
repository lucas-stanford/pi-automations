import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type KeyMatcher } from "./keyboard.js";
export interface AutomationsExtensionOptions {
    readonly agentDir: string;
    readonly matchesKey?: KeyMatcher;
}
export declare function createAutomationsExtension(pi: ExtensionAPI, options: AutomationsExtensionOptions): void;
