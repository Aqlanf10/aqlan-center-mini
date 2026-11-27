import { afterEach, expect, it, vi } from "vitest";
import type { FingerprintBucketSelection } from "../lib/schema-fingerprint";

const state = vi.hoisted(() => ({ end: vi.fn(), entries: 1 }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Client: class extends EventEmitter {
    connection = { stream: { destroy: vi.fn() } };
    async connect() {}
    async end() { state.end(); }
  } };
});
vi.mock("../lib/schema-preflight", async (original) => {
  const actual = await original<typeof import("../lib/schema-preflight")>();
  const { fingerprintBucketResponse } = await import("../lib/schema-fingerprint");
  return { ...actual, inspectSchemaReadOnly: vi.fn(async (_client: unknown, _files: unknown, options: { fingerprintBuckets?: FingerprintBucketSelection | null }) => ({
    format: "aqlan-read-only-schema-preflight", formatVersion: 1, postgresMajor: 18,
    catalog: {}, adoptionAssessment: "NOT_PERFORMED", schemaEquivalence: "NOT_ASSESSED",
    fingerprintBuckets: fingerprintBucketResponse({
      formatVersion: 1, postgresVersionNum: 180004, disclosurePolicySha256: "a".repeat(64),
      sections: {
        columns: { count: state.entries, withheldIdentityCount: 0, entries: Array.from({ length: state.entries }, () => ({
          identitySha256: "0".repeat(64), entrySha256: "1".repeat(64),
          properties: { ordinal: "2".repeat(64) }, withheldPropertyCount: 0,
        })) },
        constraints: { count: 0, withheldIdentityCount: 0, entries: [] },
        internalTriggers: { count: 0, withheldIdentityCount: 0, entries: [] },
      },
    }, options.fingerprintBuckets ?? undefined),
  })) };
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); state.entries = 1; });

it("refuses an oversized complete detail response without partial stdout, after cleanup", async () => {
  const { runPreflightCli, preflightErrorCode } = await import("../scripts/db-preflight");
  state.entries = 300;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(runPreflightCli(["--fingerprint-drilldown=columns:00"], {
    NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/aqlan_p1_test",
  })).rejects.toMatchObject({ code: "FINGERPRINT_RESPONSE_LIMIT" });
  expect(state.end).toHaveBeenCalledOnce();
  expect(output).not.toHaveBeenCalled();
  expect(preflightErrorCode({ code: "FINGERPRINT_RESPONSE_LIMIT" })).toBe("FINGERPRINT_RESPONSE_LIMIT");
});

it("emits one complete compact summary within the cap even when a detail bucket is too large", async () => {
  const { runPreflightCli } = await import("../scripts/db-preflight");
  state.entries = 300;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await runPreflightCli(["--fingerprint-drilldown"], {
    NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/aqlan_p1_test",
  })).toBe(0);
  const text = output.mock.calls[0][0] as string;
  expect(text.split("\n")).toHaveLength(1);
  expect(Buffer.byteLength(text) + 1).toBeLessThanOrEqual(48 * 1024);
  const report = JSON.parse(text);
  expect(report.fingerprintDrilldown.sections.columns.knownEntryCount).toBe(300);
  expect(report.fingerprintDrilldown.sections.columns.buckets[0].count).toBe(300);
  expect(report.provenance.bundleSha256).toBeNull();
  expect(report.provenance.manifestSha256).toBeNull();
});
