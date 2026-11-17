/** 0129 §8 (owner #483 6886911163): the blind opening count on the legacy runtime, on the built server and
 * the shared synthetic database. Before the next count is fixed, the latest close's amounts never reach a
 * legacy role other than the admin: not on GET /api/shifts, the reconciliation feed or the shift print page.
 * A differing opening opens at once and tells the opener only that it waits for review. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let sealedId = 0;
// A count no other file uses, in every way it can be printed (Latin or Arabic-Indic digits, any grouping).
const PREVIOUS = /4[,٬]?321|٤[,٬]?٣٢١/;
const get = (path: string, who: "admin" | "reception" | "accountant") => fetch(`${baseUrl}${path}`, { headers: { cookie: h.sessions[who].cookie } });
const count = async (sql: string) => Number((await db.query(sql)).rows[0].n);

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  // Files share this database: close any open shift structurally, then make the latest close this file's own.
  await db.query(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW() WHERE status = 'open'`);
  sealedId = (await db.query<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at, opening_yer, counted_yer, counted_sar, counted_usd, note, difference_reason)
     VALUES ('syn-blind-legacy', 'closed', 'syn-blind-legacy', NOW() + INTERVAL '1 second', 0, 4321, 0, 0, 'SYN-SEALED-NOTE', 'SYN-SEALED-REASON') RETURNING id`)).rows[0].id;
}, 240_000);

afterAll(async () => {
  await db?.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'syn-blind-legacy-reopen', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  await db?.end();
});

describe("legacy: the previous close is sealed until the next count is fixed", () => {
  it("reception and the accountant never receive the latest close's amounts or texts; the admin does", async () => {
    for (const who of ["reception", "accountant"] as const) {
      const shifts = await get("/api/shifts", who);
      expect(shifts.status).toBe(200);
      const body = await shifts.json();
      expect(body.open).toBeNull();
      const sealed = body.recent.find((s: { id: number }) => s.id === sealedId);
      expect(sealed).toMatchObject({ counted: null, expected: null, difference: null, note: null, differenceReason: null, sealed: true });
      expect(JSON.stringify(body)).not.toMatch(PREVIOUS);
      expect(JSON.stringify(body)).not.toMatch(/SYN-SEALED-(NOTE|REASON)/);
      const reconciliation = await get("/api/finance/reconciliation", who);
      if (reconciliation.status === 200) {
        const text = await reconciliation.text();
        expect(text).not.toMatch(PREVIOUS);
        expect(text).not.toContain("SYN-SEALED-NOTE");
        expect(JSON.parse(text).shifts.find((s: { id: number }) => s.id === sealedId)).toMatchObject({ counted: null, sealed: true });
      } else {
        expect([401, 403]).toContain(reconciliation.status);
      }
      const print = await get(`/print/shift/${sealedId}`, who);
      if (print.status === 200) {
        const html = await print.text();
        expect(html).not.toMatch(PREVIOUS);
        expect(html).toContain("مختوم حتى افتتاح الوردية التالية");
      } else {
        expect(print.status).toBe(404);
      }
    }
    const admin = await (await get("/api/shifts", "admin")).json();
    expect(admin.recent.find((s: { id: number }) => s.id === sealedId)).toMatchObject({ counted: { YER: 4321, SAR: 0, USD: 0 } });
    expect(await (await get(`/print/shift/${sealedId}`, "admin")).text()).toMatch(PREVIOUS);
  });

  it("a differing opening opens at once (no refusal to probe); the opener learns only that it waits for review", async () => {
    const moneyBefore = await count("SELECT (SELECT count(*) FROM payments) + (SELECT count(*) FROM expenses) AS n");
    const response = await authedMutation("/api/shifts", h.sessions.reception, "POST", JSON.stringify({ opening: { YER: "4000" } }));
    expect(response.status).toBe(201);
    const shift = await response.json();
    expect(shift.openingReviews).toEqual([{ id: expect.any(Number), shiftId: shift.id, currency: "YER", state: "pending" }]);
    expect(JSON.stringify(shift)).not.toMatch(PREVIOUS);
    expect(JSON.stringify(shift)).not.toMatch(/-?321\b/);
    expect((await db.query("SELECT previous_shift_id, difference_minor::int AS diff FROM shift_opening_reviews WHERE shift_id = $1", [shift.id])).rows)
      .toEqual([{ previous_shift_id: sealedId, diff: -321 }]);
    expect(await count("SELECT (SELECT count(*) FROM payments) + (SELECT count(*) FROM expenses) AS n")).toBe(moneyBefore);
    // The count is fixed, so the close is ordinary history again.
    const after = await (await get("/api/shifts", "reception")).json();
    expect(after.recent.find((s: { id: number }) => s.id === sealedId)).toMatchObject({ counted: { YER: 4321, SAR: 0, USD: 0 } });
    expect(after.open.openingReviews).toEqual([{ id: expect.any(Number), shiftId: shift.id, currency: "YER", state: "pending" }]);
    expect((await (await get("/api/shifts", "admin")).json()).open.openingReviews)
      .toEqual([expect.objectContaining({ previousCountedMinor: 4321, differenceMinor: -321 })]);
  });

  it("review and correction are canonical only: a legacy session writes nothing", async () => {
    const shift = (await db.query<{ id: number }>("SELECT id FROM cashier_shifts WHERE status = 'open'")).rows[0];
    const before = await count("SELECT count(*) AS n FROM shift_opening_corrections");
    for (const who of ["admin", "reception"] as const) {
      const response = await authedMutation("/api/shifts/opening-corrections", h.sessions[who], "POST",
        JSON.stringify({ shiftId: shift.id, opening: { YER: "4321" }, reason: "تصحيح من جلسة قديمة" }));
      expect(response.status).toBe(403);
      expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    }
    expect(await count("SELECT count(*) AS n FROM shift_opening_corrections")).toBe(before);
    expect((await db.query("SELECT opening_yer::int AS y FROM cashier_shifts WHERE id = $1", [shift.id])).rows[0].y).toBe(4000);
  });
});
