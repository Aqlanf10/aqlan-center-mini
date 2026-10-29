/** Route behaviour when canonical issuance ends with an unknown commit (Dot review
 * 6479317375 item 3). The issuer-level proof on real PostgreSQL is in
 * __tests__/postgres/staff-durable-issuer.test.ts ("lost COMMIT acknowledgement"):
 * the transaction core rethrows the original transport error. Here the route receives
 * that error and must answer with no cookie, no token, no driver text and no caching,
 * and must never fall back to the legacy login. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  legacyLookup: vi.fn(),
}));
vi.mock("@/lib/staff-entry-mode", () => ({ currentStaffEntryMode: vi.fn().mockResolvedValue("canonical") }));
vi.mock("@/lib/staff-durable-issuer", () => ({ issueDurableStaffSession: mocks.issue }));
vi.mock("@/lib/db", () => ({
  clearAccountLoginAttempts: vi.fn(), consumeStaffLoginAttempt: vi.fn(), findUserByUsername: mocks.legacyLookup,
}));
vi.mock("@/lib/loginLimit", () => ({
  accountLimitKey: vi.fn(), consumeLoginAttemptFor: vi.fn(), legacyStaffAccountKey: vi.fn(),
}));

const { POST } = await import("../app/api/auth/login/route");
const ARABIC = /[؀-ۿ]/;
const request = (accept = "application/json") => new Request("http://127.0.0.1:3000/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json", accept, origin: "http://127.0.0.1:3000" },
  body: JSON.stringify({ username: "synthetic-reception", password: "reception-pass-3" }),
});

describe("canonical login after an unknown COMMIT outcome", () => {
  beforeEach(() => { mocks.issue.mockReset(); mocks.legacyLookup.mockReset(); });

  it("JSON: 500 with a bounded Arabic message, no Set-Cookie and no driver text", async () => {
    mocks.issue.mockRejectedValue(new Error("synthetic lost COMMIT acknowledgement: connection terminated"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    const body = await response.json();
    expect(body.message).toMatch(ARABIC);
    expect(JSON.stringify(body)).not.toMatch(/COMMIT|connection|synthetic|token/i);
    expect(mocks.legacyLookup).not.toHaveBeenCalled();
  });

  it("HTML form: redirects to the login error page with no cookie", async () => {
    mocks.issue.mockRejectedValue(new Error("synthetic lost COMMIT acknowledgement"));
    const response = await POST(request("text/html"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/\/login\?error=server_error$/);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.legacyLookup).not.toHaveBeenCalled();
  });
});
