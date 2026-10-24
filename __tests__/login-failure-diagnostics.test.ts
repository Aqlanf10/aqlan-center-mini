import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), limit: vi.fn(), sharedLimit: vi.fn(), clearLimits: vi.fn(), verify: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn() }), headers: async () => ({ get: vi.fn() }) }));
vi.mock("@/lib/db", () => ({
  findUserByUsername: mocks.user, consumeStaffLoginAttempt: mocks.limit, consumeLoginAttempt: mocks.sharedLimit,
  clearAccountLoginAttempts: mocks.clearLimits,
}));
vi.mock("@/lib/auth", async importOriginal => {
  const original = await importOriginal<typeof import("../lib/auth")>();
  return { ...original, verifyPassword: (...args: Parameters<typeof original.verifyPassword>) => mocks.verify(...args) ?? original.verifyPassword(...args) };
});

import { POST as login } from "../app/api/auth/login/route";
import { loginFailureDiagnostic } from "../lib/login-failure-diagnostics";

// Synthetic secret-bearing values. None may ever reach a log argument.
const USERNAME = "synthetic_diag_user";
const PASSWORD = "Synthetic-diag-PASSWORD-9431";
const SECRETS = [USERNAME, PASSWORD, "postgres://svc:hunter2@db.internal:5432/clinic", "SELECT * FROM patients",
  "Synthetic Patient Name", "ortho_strategy_revisions", "x-forwarded-for", "stack-secret", "cause-secret", "detail-secret", "hint-secret"];
function secretBearing(message: string, extra: Record<string, unknown> = {}) {
  const error = Object.assign(new Error(message), { detail: "detail-secret SELECT * FROM patients", hint: "hint-secret", where: "postgres://svc:hunter2@db.internal:5432/clinic", ...extra });
  error.stack = `stack-secret ${PASSWORD}`;
  (error as { cause?: unknown }).cause = new Error(`cause-secret ${USERNAME}`);
  return error;
}

describe("loginFailureDiagnostic (allowlist only)", () => {
  it.each([
    ["ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051: ortho_strategy_revisions,ortho_strategy_revisions_pkey", { category: "ORTHO_UNREGISTERED_OBJECT_COLLISION", version: "0051" }],
    ["ORTHO_MIGRATION_REGISTRY_MISMATCH: 0052", { category: "ORTHO_MIGRATION_REGISTRY_MISMATCH", version: "0052" }],
    ["ORTHO_MIGRATION_SOURCE_MISMATCH: 0051", { category: "ORTHO_MIGRATION_SOURCE_MISMATCH", version: "0051" }],
    ["RUNTIME_MIGRATION_REGISTRY_MISMATCH: 0066", { category: "RUNTIME_MIGRATION_REGISTRY_MISMATCH", version: "0066" }],
    ["RUNTIME_MIGRATION_SOURCE_MISMATCH: 0069", { category: "RUNTIME_MIGRATION_SOURCE_MISMATCH", version: "0069" }],
    ["ORTHO_UNREGISTERED_OBJECT_COLLISION: 51x: injected", { category: "ORTHO_UNREGISTERED_OBJECT_COLLISION" }],
    ["SESSION_SECRET غير مضبوط", { category: "session_secret_missing" }],
    ["prefix ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051", { category: "unclassified" }],
  ])("%s", (message, expected) => {
    expect(loginFailureDiagnostic("rate_limit", new Error(message))).toEqual({ event: "staff_login_failed", stage: "rate_limit", ...expected });
  });

  it.each([
    ["08006", "database_connection"], ["ECONNREFUSED", "database_connection"], ["57P01", "database_connection"],
    ["53300", "database_resources"], ["57014", "query_canceled"], ["42P01", "schema_object_missing"], ["23505", "unclassified"], ["XX000", "unclassified"],
  ])("code %s -> %s", (code, category) => {
    expect(loginFailureDiagnostic("user_lookup", secretBearing("connect failed", { code }))).toEqual({ event: "staff_login_failed", stage: "user_lookup", category });
  });

  it("non-Error throws and hostile objects are unclassified", () => {
    for (const thrown of [null, undefined, "SESSION_SECRET", 42, { message: "ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051" }, { code: { toString: () => "08006" } }]) {
      expect(loginFailureDiagnostic("session_issue", thrown).category).toBe("unclassified");
    }
  });
});

describe("POST /api/auth/login failure diagnostics", () => {
  let errors: { mock: { calls: unknown[][] }; mockRestore: () => void };
  const saved = process.env.SESSION_SECRET;
  const request = () => login(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-forwarded-for": "198.51.100.7" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  }));
  const logged = () => errors.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
  beforeEach(() => {
    process.env.SESSION_SECRET = "synthetic-login-diagnostics-secret-0123456789";
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.limit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.sharedLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.clearLimits.mockResolvedValue(undefined);
    mocks.user.mockResolvedValue(null);
    mocks.verify.mockReturnValue(undefined);
  });
  afterEach(() => {
    errors.mockRestore(); vi.clearAllMocks();
    if (saved === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved;
  });
  function expectOnlyLine(line: Record<string, string>) {
    expect(logged()).toEqual([JSON.stringify(line)]);
    for (const text of logged()) for (const secret of SECRETS) expect(text).not.toContain(secret);
  }

  it("schema guard during the rate-limit stage: 500 unchanged, one sanitised line with category and version", async () => {
    mocks.limit.mockRejectedValue(secretBearing("ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051: ortho_strategy_revisions,reject_ortho_strategy_revision_mutation"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تسجيل الدخول. أعد المحاولة." });
    expectOnlyLine({ event: "staff_login_failed", stage: "rate_limit", category: "ORTHO_UNREGISTERED_OBJECT_COLLISION", version: "0051" });
  });

  it("database error during user lookup is categorised by code, never by text", async () => {
    mocks.user.mockRejectedValue(secretBearing(`password authentication failed for ${USERNAME} at postgres://svc:hunter2@db.internal:5432/clinic`, { code: "08006" }));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تسجيل الدخول. أعد المحاولة." });
    expectOnlyLine({ event: "staff_login_failed", stage: "user_lookup", category: "database_connection" });
  });

  it("an arbitrary secret-bearing error during password verification is unclassified", async () => {
    mocks.user.mockResolvedValue({ id: 1, username: USERNAME, displayName: "Synthetic Patient Name", role: "admin", passwordHash: "scrypt:invalid", partyId: null, permissions: null });
    mocks.verify.mockImplementation(() => { throw secretBearing(`Synthetic Patient Name ${PASSWORD} SELECT * FROM patients`); });
    const response = await request();
    expect(response.status).toBe(500);
    expectOnlyLine({ event: "staff_login_failed", stage: "password_verify", category: "unclassified" });
  });

  it("missing SESSION_SECRET at session issue keeps the 503 response and logs only the category", async () => {
    delete process.env.SESSION_SECRET;
    mocks.user.mockResolvedValue({ id: 1, username: USERNAME, displayName: "Synthetic", role: "admin", passwordHash: "x", partyId: null, permissions: null });
    mocks.verify.mockResolvedValue(true);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "الأداة غير مكتملة الإعداد: SESSION_SECRET ناقص في إعدادات النشر." });
    expectOnlyLine({ event: "staff_login_failed", stage: "session_issue", category: "session_secret_missing" });
  });

  it("successful and wrong-password logins emit no diagnostic", async () => {
    expect((await request()).status).toBe(401);
    expect(logged()).toEqual([]);
  });
});
