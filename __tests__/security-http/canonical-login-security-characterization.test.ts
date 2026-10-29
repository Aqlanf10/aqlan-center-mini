/**
 * Characterization of TODAY's canonical login and logout behaviour (review 6507696166
 * item 7; design in docs/security/staff-cutover/LOGIN_SESSION_SECURITY.md). These tests
 * pin the current gaps so that the reviewed design flips them deliberately; they change
 * no behaviour. Built application, owned database and server; synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-l-owner", password: "Canon#LOwner1", role: "admin", display: "المالك التجريبي" },
  staff: { username: "canon-l-staff", password: "Canon#LStaff1", role: "reception", display: "موظف تجريبي", grants: { "staff.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;

beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 29, secret: "canonical-login-characterization-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner" });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const auditCount = async (action: string) => Number((await journey.db.query("SELECT count(*) FROM audit_log WHERE action=$1", [action])).rows[0].count);
const allAudits = async () => Number((await journey.db.query("SELECT count(*) FROM audit_log")).rows[0].count);
async function attempt(username: string, password: string) {
  const response = await fetch(`${journey.baseUrl}/api/auth/login`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Origin: journey.baseUrl },
    body: JSON.stringify({ username, password }),
  });
  return { status: response.status, body: await response.text(), cookie: response.headers.get("set-cookie") };
}

it("S1 (gap): a copy of the logged-out cookie is still admitted after logout", async () => {
  const { cookie } = await journey.login("staff");
  const copy = cookie;
  const logout = await journey.api("/api/auth/logout", cookie, { method: "POST" });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/i);
  const me = await journey.api("/api/auth/me", copy);
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ username: ACCOUNTS.staff.username });
});

it("S2/S3 (gap): failed logins and logouts leave no audit row; a successful login writes exactly one", async () => {
  const before = await allAudits(), logins = await auditCount("auth.canonical_login");
  expect((await attempt(ACCOUNTS.staff.username, "wrong-password-1")).status).toBe(401);
  expect((await attempt("canon-l-nobody", "wrong-password-1")).status).toBe(401);
  expect(await allAudits()).toBe(before);
  const { cookie } = await journey.login("staff");
  expect(await auditCount("auth.canonical_login")).toBe(logins + 1);
  const afterLogin = await allAudits();
  await journey.api("/api/auth/logout", cookie, { method: "POST" });
  expect(await allAudits()).toBe(afterLogin);
});

it("S5 (kept): unknown user and wrong password answer identically and set no cookie", async () => {
  const unknown = await attempt("canon-l-nobody-2", "wrong-password-2");
  const wrong = await attempt(ACCOUNTS.owner.username, "wrong-password-2");
  expect([unknown.status, unknown.body]).toEqual([wrong.status, wrong.body]);
  expect(unknown.cookie).toBeNull();
  expect(wrong.cookie).toBeNull();
});
