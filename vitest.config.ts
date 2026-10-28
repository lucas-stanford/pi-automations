import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    /** Removes every file's temp directories when it finishes. See `test/setup/temp.ts`. */
    setupFiles: ["test/setup/temp.ts"],
    testTimeout: 10000,
    // Suites that drive real child processes keep a worker busy for tens of seconds; the default
    // reporter RPC timeout would fail the run even though every test passes.
    teardownTimeout: 60_000,
    hookTimeout: 60_000,
    // The heavy suites wait on child processes; more workers only starve the reporter.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
