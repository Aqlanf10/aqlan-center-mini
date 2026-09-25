import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness, loginStaff } from "./_server";

/**
 * (P2-2) تغيير كلمة المرور ذاتيًّا على التطبيق المبني.
 *
 * العيب (تدقيق الجاهزية): الاستقبال PATCH /api/users/<id> {password} ⇒ 403 — لا
 * طريق لموظفٍ أن يغيّر كلمته بنفسه. الحساب هنا حسابٌ مخصّص للاختبار كي لا تُمسّ
 * جلسات بقية الملفات.
 */

let h: Awaited<ReturnType<typeof harness>>;
const username = `selfpw${Date.now() % 1_000_000}`;
const firstPassword = "SelfPw#Pass1";
const secondPassword = "SelfPw#Pass2-new";

const change = (cookie: string, body: unknown) =>
  authedMutation("/api/auth/password", { cookie, token: "" }, "POST", JSON.stringify(body));

beforeAll(async () => {
  h = await harness();
  const created = await authedMutation("/api/users", h.sessions.admin, "POST", JSON.stringify({
    username, displayName: "موظف كلمة المرور", role: "reception", password: firstPassword,
  }));
  expect(created.status).toBe(201);
}, 240_000);

describe("P2-2 — self-service password change", () => {
  it("audit repro: a non-admin still cannot change passwords through user management", async () => {
    const users = await (await authedGet("/api/users", h.sessions.admin)).json() as { id: number; username: string }[];
    const own = users.find((user) => user.username === username)!;
    const { cookie } = await loginStaff(username, firstPassword);
    const response = await authedMutation(`/api/users/${own.id}`, { cookie, token: "" }, "PATCH",
      JSON.stringify({ password: "whatever-123" }));
    expect(response.status).toBe(403);
  });

  it("without a session ⇒ 401", async () => {
    const response = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ currentPassword: firstPassword, newPassword: secondPassword }),
    });
    expect(response.status).toBe(401);
  });

  it("wrong current password, short or unchanged new password are refused in Arabic", async () => {
    const { cookie } = await loginStaff(username, firstPassword);
    const wrong = await change(cookie, { currentPassword: "not-it-000", newPassword: secondPassword });
    expect(wrong.status).toBe(403);
    expect((await wrong.json() as { message: string }).message).toBe("كلمة المرور الحالية غير صحيحة.");
    expect((await change(cookie, { currentPassword: firstPassword, newPassword: "short" })).status).toBe(400);
    expect((await change(cookie, { currentPassword: firstPassword, newPassword: firstPassword })).status).toBe(400);
  });

  it("changes the password, keeps this device signed in and signs every other session out", async () => {
    const thisDevice = await loginStaff(username, firstPassword);
    const otherDevice = await loginStaff(username, firstPassword);

    const response = await change(thisDevice.cookie, { currentPassword: firstPassword, newPassword: secondPassword });
    expect(response.status).toBe(200);
    const renewed = (response.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(";")[0])
      .find((pair) => pair.startsWith("aqlan_flow_session="));
    expect(renewed).toBeTruthy();

    expect((await authedGet("/api/auth/me", { cookie: renewed!, token: "" })).status).toBe(200);
    const stale = await authedGet("/api/patients", { cookie: otherDevice.cookie, token: "" });
    expect(stale.status).toBe(401);

    await expect(loginStaff(username, firstPassword)).rejects.toThrow();
    await expect(loginStaff(username, secondPassword)).resolves.toHaveProperty("cookie");
  });

  it("the change is audited under the user's own name", async () => {
    const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
    await db.connect();
    try {
      const { rows } = await db.query<{ actor: string; details: Record<string, unknown> }>(
        `SELECT actor, details FROM audit_log WHERE action = 'user.update' AND actor = $1 AND details ? 'التغيير' ORDER BY id DESC LIMIT 1`,
        [username],
      );
      expect(rows[0]?.actor).toBe(username);
      expect(rows[0]?.details["التغيير"]).toBe("غيّر كلمة مروره بنفسه");
    } finally {
      await db.end();
    }
  });
});
