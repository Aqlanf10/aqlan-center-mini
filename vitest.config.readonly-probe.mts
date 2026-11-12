import { defineConfig } from "vitest/config";
import postgresConfig from "./vitest.config.postgres.mts";

// Standalone owned-cluster experiment, never part of ordinary PostgreSQL CI.
// Retain the standard target/version setup and serial execution settings.
export default defineConfig({
  ...postgresConfig,
  test: {
    ...postgresConfig.test,
    include: ["scripts/probes/canonical-readonly-protocol.probe.ts"],
  },
});
