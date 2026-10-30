/** Slice 26: real password admission and real shift commands on a built server
 * and an owned synthetic database. Financial writers outside shifts stay out. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const GRANTS = { "finance.shifts.view": true, "finance.shifts.operate": true };
const ACCOUNTS = {
  owner: { username: "canon-shift-owner", password: "Canon#ShiftOwner1", role: "admin", display: "المالك التجريبي" },
  operator: { username: "canon-shift-operator", password: "Canon#ShiftOperator1", role: "reception", display: "مسؤول الصندوق", grants: GRANTS },
  doctor: { username: "canon-shift-doctor", password: "Canon#ShiftDoctor1", role: "doctor", doctor: true, patientScope: "own", display: "طبيب مفوض", grants: GRANTS },
  reader: { username: "canon-shift-reader", password: "Canon#ShiftReader1", role: "accountant", display: "قارئ الصندوق", grants: { "finance.shifts.view": true } },
  ungrantedAdmin: { username: "canon-shift-admin", password: "Canon#ShiftAdmin1", role: "admin", display: "مدير بلا منح", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 33, secret: "canonical-shifts-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner" });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
const request = (cookie: string, method: "POST" | "PATCH", body: object) => journey.api("/api/shifts", cookie, { method, body: JSON.stringify(body) });

it("HTTP: exact grants control writes; role labels and adjacent read grants do not authorize opening or closing", async () => {
  for (const key of ["reader", "ungrantedAdmin"] as const) {
    const login = await journey.login(key);
    expect(login.status).toBe(200);
    // Read projection is still held for a policy decision. A canonical cookie
    // must not fall through and expose the legacy finance feed in this batch.
    expect((await journey.api("/api/shifts", login.cookie)).status).toBe(401);
    for (const method of ["POST", "PATCH"] as const) {
      const response = await request(login.cookie, method, { id: 1, opening: {}, counted: {} });
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    }
  }
  const doctor = await journey.login("doctor");
  const opened = await request(doctor.cookie, "POST", { opening: { YER: "1000", SAR: "12.34", USD: "56.78" }, openedBy: "forged" });
  expect(opened.status).toBe(201);
  const shift = await opened.json();
  expect(shift).toMatchObject({ openedBy: ACCOUNTS.doctor.username, opening: { YER: 1000, SAR: 1234, USD: 5678 } });
  expect((await request(doctor.cookie, "POST", { opening: {} })).status).toBe(409);
  const refused = await request(doctor.cookie, "PATCH", { id: shift.id, counted: { YER: "999", SAR: "12.34", USD: "56.78" } });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "difference_reason_required", difference: { YER: -1, SAR: 0, USD: 0 } });
  expect((await journey.db.query("SELECT status FROM cashier_shifts WHERE id=$1", [shift.id])).rows[0].status).toBe("open");
  const body = { id: shift.id, counted: { YER: "999", SAR: "12.34", USD: "56.78" }, differenceReason: "سبب تجريبي", closedBy: "forged" };
  const closed = await request(doctor.cookie, "PATCH", body);
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ status: "closed", closedBy: ACCOUNTS.doctor.username, difference: { YER: -1, SAR: 0, USD: 0 } });
  expect((await request(doctor.cookie, "PATCH", body)).status).toBe(409);
  expect((await journey.db.query("SELECT action,actor FROM audit_log WHERE entity='shift' AND entity_id=$1 ORDER BY id", [String(shift.id)])).rows)
    .toEqual([{ action: "shift.open", actor: ACCOUNTS.doctor.username }, { action: "shift.close", actor: ACCOUNTS.doctor.username }]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: untrusted bodies, cross-origin writes, and stale sessions have no effect", async () => {
  const operator = await journey.login("operator");
  const before = (await journey.db.query("SELECT count(*)::int AS n FROM cashier_shifts")).rows[0].n;
  for (const body of [[], { opening: { YER: "-1" } }, { opening: { USD: true } }, { opening: { USD: [] } }]) {
    expect((await request(operator.cookie, "POST", body)).status).toBe(400);
  }
  const crossOrigin = await journey.api("/api/shifts", operator.cookie, { method: "POST", headers: { Origin: "https://invalid.example" }, body: JSON.stringify({ opening: {} }) });
  expect(crossOrigin.status).toBe(403);
  const malformed = await journey.api("/api/shifts", operator.cookie, { method: "POST", body: "{" });
  expect(malformed.status).toBe(400);
  await journey.db.query("UPDATE users SET permissions=jsonb_set(permissions::jsonb,'{revision}','2'::jsonb)::text WHERE id=$1", [journey.ids.operator]);
  const stale = await request(operator.cookie, "POST", {});
  expect(stale.status).toBe(401);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM cashier_shifts")).rows[0].n).toBe(before);
  expect(await journey.ddlLog()).toEqual([]);
});
