import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_SOURCE_SQL } from "../lib/audit-source-schema";

describe("audit source (P3-5)", () => {
  afterEach(() => {
    vi.doUnmock("next/headers");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps migration 0019 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0019_audit_source.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(AUDIT_SOURCE_SQL.trim());
  });

  const mockHeaders = (values: Record<string, string>) => {
    vi.doMock("next/headers", () => ({
      headers: async () => ({ get: (name: string) => values[name.toLowerCase()] ?? null }),
    }));
  };

  it("records the proxy-added IP only behind a trusted proxy", async () => {
    mockHeaders({ "x-forwarded-for": "6.6.6.6, 10.0.0.7", "user-agent": "Mozilla/5.0 Test" });
    vi.stubEnv("TRUST_PROXY", "true");
    const { currentAuditSource } = await import("../lib/audit-source");
    expect(await currentAuditSource()).toEqual({ ip: "10.0.0.7", userAgent: "Mozilla/5.0 Test" });
  });

  it("does not trust a client-written forwarded header without a proxy", async () => {
    mockHeaders({ "x-forwarded-for": "6.6.6.6", "user-agent": "UA\r\nInjected" });
    vi.stubEnv("TRUST_PROXY", "");
    const { currentAuditSource } = await import("../lib/audit-source");
    expect(await currentAuditSource()).toEqual({ ip: null, userAgent: "UA  Injected" });
  });

  it("outside a request it returns nulls instead of failing the audit", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => { throw new Error("outside request scope"); },
    }));
    const { currentAuditSource } = await import("../lib/audit-source");
    expect(await currentAuditSource()).toEqual({ ip: null, userAgent: null });
  });
});
