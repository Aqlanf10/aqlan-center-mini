import { beforeAll, describe, expect, it } from "vitest";
import { authedMutation, baseUrl, harness, loginStaff } from "./_server";

/**
 * عدّاد محاولات الدخول للمحاولات الفاشلة — لا لكل دخول.
 *
 * العيب: الحدّ (٥ في ربع ساعة) كان يعدّ كل دخول ناجح ولا يُصفَّر أبدًا، فموظفٌ يدخل
 * ست مراتٍ صحيحة (أكثر من جهاز صباحًا، أو بعد تغيير كلمته) يُقفل خارج البرنامج ربع
 * ساعة. والإقفال بعد المحاولات الخاطئة يجب أن يبقى كما هو.
 */

let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now() % 1_000_000;
const okUser = `limitok${stamp}`;
const lockUser = `limitlk${stamp}`;
const password = "Limit#Pass123";

async function wrongLogin(username: string) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username, password: "wrong-password-1" }),
  });
}

beforeAll(async () => {
  h = await harness();
  for (const username of [okUser, lockUser]) {
    const created = await authedMutation("/api/users", h.sessions.admin, "POST", JSON.stringify({
      username, displayName: "موظف حدّ الدخول", role: "reception", password,
    }));
    expect(created.status).toBe(201);
  }
}, 240_000);

describe("login limiter counts failures, not successes", () => {
  it("eight correct logins in a row all succeed", async () => {
    for (let index = 0; index < 8; index += 1) {
      await expect(loginStaff(okUser, password)).resolves.toHaveProperty("cookie");
    }
  });

  it("after five wrong passwords the account is still locked, even for the right password", async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await wrongLogin(lockUser)).status).toBe(401);
    }
    expect((await wrongLogin(lockUser)).status).toBe(429);
    await expect(loginStaff(lockUser, password)).rejects.toThrow(/429/);
  });
});
