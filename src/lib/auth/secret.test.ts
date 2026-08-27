import { describe, expect, it } from "vitest";

import {
  DEV_FALLBACK_SECRET,
  isProductionRuntime,
  MIN_AUTH_SECRET_LENGTH,
  resolveAuthSecret,
} from "./secret";

const VALID_SECRET = "a-sufficiently-long-secret-0123456789";

describe("isProductionRuntime", () => {
  it("detects production runtime (no NEXT_PHASE)", () => {
    expect(isProductionRuntime("production", undefined)).toBe(true);
  });

  it("detects production runtime server phase", () => {
    expect(isProductionRuntime("production", "phase-production-server")).toBe(true);
  });

  it("excludes the build phase from runtime", () => {
    expect(isProductionRuntime("production", "phase-production-build")).toBe(false);
  });

  it("excludes development and test", () => {
    expect(isProductionRuntime("development", undefined)).toBe(false);
    expect(isProductionRuntime("test", undefined)).toBe(false);
  });
});

describe("resolveAuthSecret", () => {
  it("returns a valid provided secret", () => {
    expect(resolveAuthSecret({ AUTH_SECRET: VALID_SECRET }, "production", undefined)).toBe(
      VALID_SECRET
    );
  });

  it("refuses to boot in production runtime without a secret", () => {
    expect(() => resolveAuthSecret({}, "production", undefined)).toThrow(/AUTH_SECRET/);
  });

  it("refuses to boot in production runtime with a too-short secret", () => {
    expect(() =>
      resolveAuthSecret({ AUTH_SECRET: "short" }, "production", undefined)
    ).toThrow(/AUTH_SECRET/);
  });

  it("falls back during the build phase (no traffic served)", () => {
    expect(resolveAuthSecret({}, "production", "phase-production-build")).toBe(
      DEV_FALLBACK_SECRET
    );
  });

  it("falls back in development and test", () => {
    expect(resolveAuthSecret({}, "development", undefined)).toBe(DEV_FALLBACK_SECRET);
    expect(resolveAuthSecret({}, "test", undefined)).toBe(DEV_FALLBACK_SECRET);
  });

  it("documents the minimum length", () => {
    expect(MIN_AUTH_SECRET_LENGTH).toBeGreaterThanOrEqual(16);
  });
});
