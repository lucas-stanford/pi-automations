// Runs before every test file (vitest `setupFiles`).
//
// Removes the directories `helpers/temp.ts` made once the file has finished, so a test file cannot
// leave them behind by forgetting to ask. A file may still clean up earlier, between its tests.

import { afterAll } from "vitest";

import { cleanupTempDirs } from "../helpers/temp.js";

afterAll(cleanupTempDirs);
