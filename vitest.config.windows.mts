import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

/** Application unit coverage on Windows. These six Linux release-proof suites
 * remain mandatory and unfiltered in the main Ubuntu CI workflow; they require
 * POSIX symlinks, Bash/Docker job semantics, or Next's Linux trace matcher. */
export default mergeConfig(base, defineConfig({
  test: {
    exclude: [
      "__tests__/braces-runtime-verifier.test.mjs",
      "__tests__/braces-installed-verifier.test.mjs",
      "__tests__/finance-candidate-image-workflow.test.ts",
      "__tests__/nonfinancial-candidate-image-workflow.test.ts",
      "__tests__/ci-required-completion.test.ts",
      "__tests__/development-runtime-tracing.test.ts",
    ],
  },
}));
