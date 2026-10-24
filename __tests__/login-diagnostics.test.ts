import { afterEach, describe, expect, it, vi } from "vitest";
import { loginFailureDiagnostic, reportLoginFailure } from "../lib/login-diagnostics";

const secret = "synthetic-password-postgresql://user:secret@private.invalid/db";
afterEach(() => vi.restoreAllMocks());
describe("closed login diagnostics", () => {
  it.each(["ORTHO_UNREGISTERED_OBJECT_COLLISION", "ORTHO_MIGRATION_REGISTRY_MISMATCH", "ORTHO_MIGRATION_SOURCE_MISMATCH"])("allows only pinned versions for %s", category => {
    for (const version of ["0051", "0052"]) {
      const error = Object.assign(new Error(`${category}: ${version}: ${secret}`, { cause: secret }), { detail: secret, sql: secret, username: secret });
      error.stack = secret;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      reportLoginFailure("legacy_limit", error);
      expect(log).toHaveBeenLastCalledWith(JSON.stringify({ event: "staff_login_failed", stage: "legacy_limit", category, version }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
  });
  it.each([new Error(secret), { code: "ABCDE", message: secret }, new Error(`ORTHO_UNREGISTERED_OBJECT_COLLISION: 9999: ${secret}`), new Error(`ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051${secret}`), null, secret])("does not echo arbitrary error metadata", error => {
    expect(loginFailureDiagnostic("user_lookup", error)).toEqual({ event: "staff_login_failed", stage: "user_lookup", category: "unclassified" });
  });
  it("does not invoke message accessors", () => {
    const get = vi.fn(() => { throw new Error(secret); });
    const error = new Error(); Object.defineProperty(error, "message", { get });
    expect(loginFailureDiagnostic("session", error).category).toBe("unclassified");
    expect(get).not.toHaveBeenCalled();
  });
  it("does not propagate logger failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => { throw new Error(secret); });
    expect(() => reportLoginFailure("response", new Error(secret))).not.toThrow();
  });
});
