import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ limit: vi.fn(), verify: vi.fn() }));
vi.mock("../lib/loginLimit", () => ({ consumeLoginAttemptFor: state.limit, accountLimitKey: vi.fn() }));
vi.mock("../lib/db", () => ({ consumeStaffLoginAttempt: vi.fn(), clearAccountLoginAttempts: vi.fn(), findUserByUsername: vi.fn() }));
vi.mock("../lib/auth", () => ({ verifyPassword: state.verify }));
import { POST } from "../app/api/auth/login/route";
afterEach(() => vi.restoreAllMocks());
describe("login diagnostic response compatibility", () => {
  it.each([false, true])("preserves response and never logs secret-bearing exception/request fields (HTML=%s)", async html => {
    const secret = "synthetic-private-password";
    const error = Object.assign(new Error(`ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051: ${secret}`, { cause: secret }), { detail: secret, code: secret });
    error.stack = secret;
    state.limit.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(new Request("http://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", accept: html ? "text/html" : "application/json" },
      body: JSON.stringify({ username: secret, password: secret }),
    }));
    expect(response.status).toBe(html ? 303 : 500);
    if (html) expect(response.headers.get("location")).toBe("http://localhost/login?error=server_error");
    else expect(await response.json()).toEqual({ message: "تعذّر تسجيل الدخول. أعد المحاولة." });
    expect(state.verify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "staff_login_failed", stage: "shared_limit", category: "ORTHO_UNREGISTERED_OBJECT_COLLISION", version: "0051" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});
