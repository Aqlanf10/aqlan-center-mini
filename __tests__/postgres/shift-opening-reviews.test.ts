/**
 * 0129 shift opening reviews (docs/finance/SHIFT_OPENING_REVIEWS_0129.md; owner #483 6831365228 item 1;
 * blind count, owner #483 6886911163, §8). Synthetic PostgreSQL database only. The count is fixed before any
 * comparison is shown; the difference is never silent, never a cash movement, never a change to the previous
 * close; only the owner or an authorized reviewer sees the amounts; corrections are authorized and audited.
 */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import type { CashierShift } from "../../lib/db";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
import { toInputAmount } from "../../lib/money";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-shift-opening-reviews-20261114");
const db = await import("../../lib/db");
const shifts = await import("../../lib/canonical-shifts");
const reviews = await import("../../lib/canonical-shift-opening-reviews");
const { CASHIER_SHIFT_LIFECYCLE_LOCK } = await import("../../lib/shift-opening-reviews");

const OPERATE = { "finance.shifts.view": true, "finance.shifts.operate": true };
const REVIEW = "finance.shifts.review-opening";
const EVERY_OTHER_FINANCE = {
  ...OPERATE, "finance.reconciliation.manage": true, "finance.reconciliation.view": true, "finance.expenses.create": true,
  "finance.expenses.view": true, "finance.expenses.void": true, "finance.journal.post": true, "finance.fx.manage": true,
  "finance.payables.record": true, "finance.opening-balances.manage": true, "finance.patient-ledger.view": true, "finance.payments.collect": true,
};
const ACCOUNTS = {
  owner: { username: "SYN-OPEN-OWNER", role: "admin" },
  operator: { username: "SYN-OPEN-OPERATOR", role: "reception", grants: OPERATE },
  reviewer: { username: "SYN-OPEN-REVIEWER", role: "accountant", grants: { "finance.shifts.view": true, [REVIEW]: true } },
  operatorReviewer: { username: "SYN-OPEN-OPREVIEW", role: "accountant", grants: { ...OPERATE, [REVIEW]: true } },
  financeAll: { username: "SYN-OPEN-FINANCE", role: "accountant", grants: EVERY_OTHER_FINANCE },
  reader: { username: "SYN-OPEN-READER", role: "accountant", grants: { "finance.shifts.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let side: Pool;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const count = async (table: string, where = "TRUE") => Number((await q(`SELECT count(*) FROM ${table} WHERE ${where}`))[0].count);
const audits = () => count("audit_log", "action IN ('shift.open','shift.close','shift.opening_review','shift.opening_correct')");
const moneySnapshot = async () => (await q(`SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) AS payments,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM expenses e) AS expenses,
  (SELECT count(*) FROM journal_manual) AS manual_journal`))[0];
const amounts = (a: CashierShift["expected"]) => ({ YER: toInputAmount(a.YER, "YER"), SAR: toInputAmount(a.SAR, "SAR"), USD: toInputAmount(a.USD, "USD") });
const open = async (key: Key, opening: Record<string, string>) =>
  shifts.commandCanonicalShiftOpen(await fx.session(key), { opening, openedBy: "forged-actor" });
/** §8.2: what an unauthorized viewer may know about a difference: that it exists, and its state. */
const STATE_ONLY = ["currency", "id", "shiftId", "state"];
const correct = async (key: Key, shiftId: number, opening: Record<string, string>, reason = "تصحيح عدّ اصطناعي بعد إعادة العدّ") =>
  reviews.commandCanonicalOpeningCorrection(await fx.session(key), { shiftId, opening, reason, correctedBy: "forged-actor" });
/** Close the open shift counting exactly `counted` (a reason is given when that differs from expected). */
async function closeCounting(key: Key, counted: Record<string, string>) {
  const current = (await db.getOpenShiftWith(fx.pool))!;
  return shifts.commandCanonicalShiftClose(await fx.session(key), { id: current.id, counted, differenceReason: "synthetic count" });
}
const review = async (key: Key, id: number, reason = "سبب مراجعة اصطناعي", settlement = "تسوية اصطناعية خارج الدرج") =>
  reviews.commandCanonicalOpeningReview(await fx.session(key), { id, reason, settlement, reviewedBy: "forged-actor" });
const shiftRow = async (id: number) => (await q("SELECT to_jsonb(s) AS row FROM cashier_shifts s WHERE id=$1", [id]))[0].row;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 4 });
}, 180_000);
beforeEach(async () => {
  const current = await db.getOpenShiftWith(fx.pool);
  if (current) await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: current.id, counted: amounts(current.expected), differenceReason: "synthetic cleanup" });
  // Every test after the first starts from a known previous count: YER 1000, nothing else.
  if (await count("cashier_shifts")) {
    await q(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at, counted_yer, counted_sar, counted_usd)
             VALUES ('SYN-RESET', 'closed', 'SYN-RESET', now(), 1000, 0, 0)`);
  }
});
afterAll(async () => { await side?.end(); await fx?.close(); });

describe("opening compared with the previous close", () => {
  it("the first shift ever has nothing to compare; a matching opening writes no review", async () => {
    expect(await count("cashier_shifts")).toBe(0);
    const first = await open("operator", { YER: "1000" });
    expect(first.openingReviews).toEqual([]);
    await closeCounting("operator", { YER: "1000" });
    const second = await open("operator", { YER: "1000" });
    expect(second.openingReviews).toEqual([]);
    expect(await count("shift_opening_reviews")).toBe(0);
  });

  it("a differing count opens at once: no refusal to probe, rows and audit in the same transaction, no money", async () => {
    await open("operator", { YER: "1000" });
    const previous = (await closeCounting("owner", { YER: "1000", SAR: "20" }))!;
    const previousRow = await shiftRow(previous.id), money = await moneySnapshot(), auditBefore = await audits();
    const shift = await open("operator", { YER: "950", SAR: "20", USD: "5" });
    expect(shift.opening).toEqual({ YER: 950, SAR: 2000, USD: 500 });
    expect(shift.expected).toEqual({ YER: 950, SAR: 2000, USD: 500 });
    // The unauthorized opener learns, after the count is committed, only which currencies wait for review.
    expect(shift.openingReviews!.map(r => Object.keys(r).sort())).toEqual([STATE_ONLY, STATE_ONLY]);
    expect(shift.openingReviews).toEqual([
      { id: expect.any(Number), shiftId: shift.id, currency: "YER", state: "pending" },
      { id: expect.any(Number), shiftId: shift.id, currency: "USD", state: "pending" },
    ]);
    // The database holds the whole truth for the reviewer.
    expect(await q("SELECT currency, previous_shift_id, previous_counted_minor::int AS prev, opening_minor::int AS opening, difference_minor::int AS diff, detected_by FROM shift_opening_reviews WHERE shift_id=$1 ORDER BY id", [shift.id]))
      .toEqual([
        { currency: "YER", previous_shift_id: previous.id, prev: 1000, opening: 950, diff: -50, detected_by: ACCOUNTS.operator.username },
        { currency: "USD", previous_shift_id: previous.id, prev: 0, opening: 500, diff: 500, detected_by: ACCOUNTS.operator.username },
      ]);
    expect(await audits()).toBe(auditBefore + 1);
    expect((await q("SELECT details FROM audit_log WHERE action='shift.open' ORDER BY id DESC LIMIT 1"))[0].details)
      .toMatchObject({ فروق_الافتتاح: [{ العملة: "YER", الفرق: -50 }, { العملة: "USD", الفرق: 500 }] });
    expect(await moneySnapshot()).toEqual(money);
    expect(await shiftRow(previous.id)).toEqual(previousRow);
    const read = await shifts.readCanonicalShifts(await fx.session("reader"));
    expect(read.open?.openingReviews?.map(r => Object.keys(r).sort())).toEqual([STATE_ONLY, STATE_ONLY]);
    expect(read.pendingOpeningReviews).toBeGreaterThanOrEqual(2);
    const full = await shifts.readCanonicalShifts(await fx.session("reviewer"));
    expect(full.open?.openingReviews).toEqual([
      expect.objectContaining({ currency: "YER", previousShiftId: previous.id, previousCountedMinor: 1000, openingMinor: 950, differenceMinor: -50, state: "pending" }),
      expect.objectContaining({ currency: "USD", previousCountedMinor: 0, differenceMinor: 500 }),
    ]);
  });

  it("no answer before the count is committed varies with the previous count, however often it is tried", async () => {
    const refusals = async () => {
      const out: unknown[] = [];
      for (const body of [{ opening: { YER: "abc" } }, { opening: { YER: "-1" } }, { opening: [] }]) {
        out.push(await shifts.commandCanonicalShiftOpen(await fx.session("operator"), body as Record<string, unknown>).catch(e => ({ code: e.code, status: e.status, message: e.message, keys: Object.keys(e).filter(k => e[k] !== undefined) })));
      }
      return out;
    };
    await open("operator", { YER: "1000" });
    await closeCounting("owner", { YER: "1000" });
    const withThousand = await refusals();
    await open("operator", { YER: "1000" });
    await closeCounting("owner", { YER: "7777" });
    expect(await refusals()).toEqual(withThousand);
    for (const refusal of withThousand) expect(JSON.stringify(refusal)).not.toMatch(/differ|previous|1000|7777/i);
    // A second opening while one is open: the same refusal whatever was counted.
    const opened = await open("operator", { YER: "1" });
    const again = await open("operator", { YER: "7777" }).catch(e => e);
    expect(again).toMatchObject({ code: "shift_already_open", status: 409 });
    expect(again.differences).toBeUndefined();
    expect(await count("cashier_shifts", "status='open'")).toBe(1);
    expect(opened.openingReviews).toHaveLength(1);
  });

  it("the protected owner opening sees the full difference", async () => {
    await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000" });
    const shift = await open("owner", { YER: "1100" });
    expect(shift.openingReviews).toEqual([expect.objectContaining({ currency: "YER", previousCountedMinor: 1000, differenceMinor: 100 })]);
  });

  it("rolls the opening and its review rows back together when the audit fails", async () => {
    await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000" });
    const shiftsBefore = await count("cashier_shifts"), rowsBefore = await count("shift_opening_reviews");
    await q("ALTER TABLE audit_log ADD CONSTRAINT synthetic_open_audit_failure CHECK (action <> 'shift.open') NOT VALID");
    try { await expect(open("operator", { YER: "900" })).rejects.toThrow(); }
    finally { await q("ALTER TABLE audit_log DROP CONSTRAINT synthetic_open_audit_failure"); }
    expect(await count("cashier_shifts")).toBe(shiftsBefore);
    expect(await count("shift_opening_reviews")).toBe(rowsBefore);
  });

  it("an unknown previous count is recorded for review when the opening is not zero", async () => {
    await q(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at, counted_yer, counted_sar, counted_usd)
             VALUES ('SYN-LEGACY-CLOSE', 'closed', 'SYN-LEGACY-CLOSE', now(), NULL, NULL, NULL)`);
    const legacy = (await q("SELECT id FROM cashier_shifts WHERE opened_by='SYN-LEGACY-CLOSE'"))[0].id;
    const shift = await open("operator", { SAR: "5" });
    expect(shift.openingReviews).toEqual([{ id: expect.any(Number), shiftId: shift.id, currency: "SAR", state: "pending" }]);
    expect(await q("SELECT previous_shift_id, previous_counted_minor, difference_minor, opening_minor::int AS opening FROM shift_opening_reviews WHERE shift_id=$1", [shift.id]))
      .toEqual([{ previous_shift_id: legacy, previous_counted_minor: null, difference_minor: null, opening: 500 }]);
  });

  it("the legacy writer records the rows the same way, with no refusal", async () => {
    const base = await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000" });
    expect(base.id).toBeGreaterThan(0);
    const opened = (await db.openShift({ openedBy: "SYN-LEGACY-OPENER", opening: { YER: 500, SAR: 0, USD: 0 } }))!;
    expect(opened.openingReviews).toEqual([expect.objectContaining({ currency: "YER", differenceMinor: -500, state: "pending" })]);
  });

  it("an opening with a difference never waits behind a writer holding the previous shift's row", async () => {
    await open("operator", { YER: "1000" });
    const previous = (await closeCounting("operator", { YER: "1000" }))!;
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      // What a payment writer keeps after its open-shift lock read was filtered out by the close.
      await holder.query("SELECT id FROM cashier_shifts WHERE id = $1 FOR UPDATE", [previous.id]);
      const opened = await Promise.race([
        open("owner", { YER: "900" }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("opening waited on the previous shift row")), 5_000)),
      ]);
      expect(opened.openingReviews).toEqual([expect.objectContaining({ previousShiftId: previous.id, differenceMinor: -100 })]);
    } finally { await holder.query("ROLLBACK").catch(() => {}); holder.release(); }
  });

  it("a review row must reference a closed previous shift", async () => {
    const shift = await open("operator", { YER: "1000" });
    await expect(q(`INSERT INTO shift_opening_reviews (shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor, difference_minor, detected_by)
      VALUES ($1, 'YER', $1 + 1000, 1, 2, 1, 'SYN')`, [shift.id])).rejects.toThrow(/وردية سابقة مقفلة/);
    const other = (await q("INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at) VALUES ('SYN-OPEN-ROW', 'closed', 'SYN', now() - interval '10 days') RETURNING id"))[0].id;
    await expect(q("UPDATE cashier_shifts SET status='open' WHERE id=$1", [other])).rejects.toThrow();
    await expect(q(`INSERT INTO shift_opening_reviews (shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor, difference_minor, detected_by)
      VALUES ($1, 'YER', $1, 1, 2, 1, 'SYN')`, [shift.id])).rejects.toThrow(/وردية سابقة مقفلة|previous_differs/);
  });

  it("the legacy opening takes the shift lifecycle lock before comparing", async () => {
    await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000" });
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [CASHIER_SHIFT_LIFECYCLE_LOCK]);
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = db.openShift({ openedBy: "SYN-LEGACY-OPENER", opening: { YER: 1000, SAR: 0, USD: 0 } });
      expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0);
      await holder.query("COMMIT");
      expect((await pending)?.openingReviews).toEqual([]);
    } finally { holder.release(); }
  });
});

describe("the review", () => {
  async function pendingRow(opener: Key = "operator") {
    await open("operator", { YER: "1000" });
    await closeCounting("owner", { YER: "1000" });
    const shift = await open(opener, { YER: "1200" });
    return shift.openingReviews![0];
  }
  const reviewRow = async (id: number) => (await q("SELECT to_jsonb(r) AS row FROM shift_opening_reviews r WHERE id=$1", [id]))[0].row;

  it("grant matrix: owner and the exact grant only; every refusal writes nothing", async () => {
    const row = await pendingRow();
    const before = await reviewRow(row.id), auditBefore = await audits();
    for (const key of ["operator", "financeAll", "reader"] as const) await expect(review(key, row.id)).rejects.toThrow(/CAPABILITY_DENIED/);
    await expect(reviews.commandCanonicalOpeningReview(await fx.session("reviewer"), { id: row.id, reason: "ab", settlement: "تسوية" }))
      .rejects.toMatchObject({ code: "invalid_opening_review", status: 400 });
    await expect(review("reviewer", 987654)).rejects.toMatchObject({ code: "opening_review_not_found", status: 404 });
    expect(await reviewRow(row.id)).toEqual(before);
    expect(await audits()).toBe(auditBefore);
    const done = await review("reviewer", row.id);
    expect(done).toMatchObject({ id: row.id, reviewReason: "سبب مراجعة اصطناعي", reviewSettlement: "تسوية اصطناعية خارج الدرج", reviewedBy: ACCOUNTS.reviewer.username });
    expect((await q("SELECT reviewed_by_user_id FROM shift_opening_reviews WHERE id=$1", [row.id]))[0].reviewed_by_user_id).toBe(fx.ids.reviewer);
    expect(await audits()).toBe(auditBefore + 1);
    expect((await q("SELECT actor, details FROM audit_log WHERE action='shift.opening_review' ORDER BY id DESC LIMIT 1"))[0])
      .toMatchObject({ actor: ACCOUNTS.reviewer.username, details: { العملة: "YER", الفرق: 200, السبب: "سبب مراجعة اصطناعي" } });
    await expect(review("owner", row.id)).rejects.toMatchObject({ code: "opening_review_already_done", status: 409 });
    expect(await audits()).toBe(auditBefore + 1);
  });

  it("separation of duties: a non-owner never reviews a shift they opened or whose previous close they made; the owner may", async () => {
    const own = await pendingRow("operatorReviewer");
    await expect(review("operatorReviewer", own.id)).rejects.toMatchObject({ code: "opening_review_own_shift", status: 403 });
    expect((await q("SELECT reviewed_at FROM shift_opening_reviews WHERE id=$1", [own.id]))[0].reviewed_at).toBeNull();
    // The owner closed the previous shift (pendingRow) and may still review.
    expect(await review("owner", own.id)).toMatchObject({ reviewedBy: ACCOUNTS.owner.username });
  });

  it("a revoked grant is refused at once", async () => {
    const row = await pendingRow();
    await fx.setGrants("reviewer", { "finance.shifts.view": true });
    try { await expect(review("reviewer", row.id)).rejects.toThrow(/CAPABILITY_DENIED/); }
    finally { await fx.setGrants("reviewer", { "finance.shifts.view": true, [REVIEW]: true }); }
    expect((await q("SELECT reviewed_at FROM shift_opening_reviews WHERE id=$1", [row.id]))[0].reviewed_at).toBeNull();
  });

  it("two concurrent reviews of one row: one wins, the other is refused, one audit row", async () => {
    const row = await pendingRow();
    const auditBefore = await audits();
    const settled = await Promise.allSettled([review("reviewer", row.id, "سبب أول"), review("owner", row.id, "سبب ثانٍ")]);
    expect(settled.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "opening_review_already_done" } });
    expect(await audits()).toBe(auditBefore + 1);
  });

  it("lists pending and all rows: states for a shift viewer, amounts only for the owner or a reviewer", async () => {
    const row = await pendingRow();
    const pending = await reviews.readCanonicalOpeningReviews(await fx.session("reader"), { status: "pending" });
    expect(pending.reviews.map(r => r.id)).toContain(row.id);
    expect(pending.reviews.every(r => r.state === "pending")).toBe(true);
    expect(pending.reviews.every(r => Object.keys(r).sort().join() === STATE_ONLY.join())).toBe(true);
    for (const key of ["reviewer", "owner"] as const) {
      const full = await reviews.readCanonicalOpeningReviews(await fx.session(key), { status: "pending" });
      expect(full.reviews.find(r => r.id === row.id)).toMatchObject({ previousCountedMinor: 1000, differenceMinor: 200, openingMinor: 1200 });
    }
    await review("reviewer", row.id);
    const after = await reviews.readCanonicalOpeningReviews(await fx.session("reader"), { status: "pending" });
    expect(after.reviews.map(r => r.id)).not.toContain(row.id);
    expect((await reviews.readCanonicalOpeningReviews(await fx.session("reader"), { status: "all" })).reviews.map(r => r.id)).toContain(row.id);
  });

  it("the table is append-only at the database", async () => {
    const row = await pendingRow();
    await expect(q("UPDATE shift_opening_reviews SET difference_minor = 1 WHERE id=$1", [row.id])).rejects.toThrow(/append-only/);
    await expect(q("UPDATE shift_opening_reviews SET detected_by = 'تعديل' WHERE id=$1", [row.id])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM shift_opening_reviews WHERE id=$1", [row.id])).rejects.toThrow(/لا تُحذف/);
    await expect(q("UPDATE shift_opening_reviews SET review_reason='سبب' WHERE id=$1", [row.id])).rejects.toThrow(/shift_opening_reviews_review_valid/);
    await review("reviewer", row.id);
    await expect(q("UPDATE shift_opening_reviews SET review_reason='سبب آخر' WHERE id=$1", [row.id])).rejects.toThrow(/مرة واحدة/);
    await expect(q("DELETE FROM cashier_shifts WHERE id=$1", [row.shiftId])).rejects.toThrow();
  });
});

describe("§8.3 the previous close is sealed until the next count is fixed", () => {
  it("withholds the latest close's amounts and texts from unauthorized viewers until the next opening", async () => {
    await open("operator", { YER: "1000" });
    const closed = (await closeCounting("operator", { YER: "990" }))!;
    expect(closed.counted).toEqual({ YER: 990, SAR: 0, USD: 0 }); // the closer's own answer
    const SEALED = { counted: null, expected: null, difference: null, sealed: true };
    for (const key of ["operator", "reader", "financeAll"] as const) {
      const feed = await shifts.readCanonicalShifts(await fx.session(key));
      expect(feed.open).toBeNull();
      expect(feed.recent[0]).toMatchObject({ id: closed.id, ...SEALED });
      expect(feed.recent[0].note ?? null).toBeNull();
      expect(feed.recent[0].differenceReason ?? null).toBeNull();
      expect(JSON.stringify(feed.recent[0])).not.toMatch(/990/);
      // Only the latest close is sealed; older history is unchanged.
      expect(feed.recent.slice(1).every(shift => !shift.sealed)).toBe(true);
    }
    for (const key of ["owner", "reviewer"] as const) {
      const feed = await shifts.readCanonicalShifts(await fx.session(key));
      expect(feed.recent[0]).toMatchObject({ id: closed.id, counted: { YER: 990, SAR: 0, USD: 0 } });
      expect(feed.recent[0].sealed).toBeFalsy();
    }
    // The legacy readers use the same rule.
    const sealedLegacy = await db.listShiftsForViewer({ authorized: false }, 15);
    expect(sealedLegacy[0]).toMatchObject({ id: closed.id, ...SEALED, note: null, differenceReason: null });
    expect((await db.listShiftsForViewer({ authorized: true }, 15))[0]).toMatchObject({ counted: { YER: 990, SAR: 0, USD: 0 } });
    expect(await db.getShiftForViewer(closed.id, { authorized: false })).toMatchObject(SEALED);
    // After the next count is fixed, that close is ordinary history again.
    await open("operator", { YER: "990" });
    const after = await shifts.readCanonicalShifts(await fx.session("operator"));
    expect(after.recent.find(s => s.id === closed.id)).toMatchObject({ counted: { YER: 990, SAR: 0, USD: 0 } });
    expect((await db.listShiftsForViewer({ authorized: false }, 15)).every(s => !s.sealed)).toBe(true);
  });
});

describe("§8.4 correction of the opening count", () => {
  async function differing() {
    await open("operator", { YER: "1000" });
    await closeCounting("owner", { YER: "1000" });
    return open("operator", { YER: "950" });
  }

  it("the reviewer corrects the open shift: append-only rows, new opening and drawer, audit, no money, detected rows unchanged", async () => {
    const shift = await differing();
    const detected = await q("SELECT to_jsonb(r) AS row FROM shift_opening_reviews r WHERE shift_id=$1", [shift.id]);
    const money = await moneySnapshot(), auditBefore = await audits();
    const result = await correct("reviewer", shift.id, { YER: "1000" });
    expect(result.corrections).toEqual([expect.objectContaining({ shiftId: shift.id, currency: "YER", fromMinor: 950, toMinor: 1000,
      reason: "تصحيح عدّ اصطناعي بعد إعادة العدّ", correctedBy: ACCOUNTS.reviewer.username })]);
    expect(result.shift.opening).toEqual({ YER: 1000, SAR: 0, USD: 0 });
    expect(result.shift.expected.YER).toBe(1000);
    expect((await db.getOpenShiftWith(fx.pool))!.opening.YER).toBe(1000);
    expect(await q("SELECT corrected_by_user_id FROM shift_opening_corrections WHERE shift_id=$1", [shift.id])).toEqual([{ corrected_by_user_id: fx.ids.reviewer }]);
    expect(await q("SELECT to_jsonb(r) AS row FROM shift_opening_reviews r WHERE shift_id=$1", [shift.id])).toEqual(detected);
    expect(await moneySnapshot()).toEqual(money);
    expect(await audits()).toBe(auditBefore + 1);
    expect((await q("SELECT actor, details FROM audit_log WHERE action='shift.opening_correct' ORDER BY id DESC LIMIT 1"))[0])
      .toMatchObject({ actor: ACCOUNTS.reviewer.username, details: { التصحيحات: [{ العملة: "YER", من: 950, إلى: 1000 }] } });
    // The correction is listed for authorized readers.
    const full = await shifts.readCanonicalShifts(await fx.session("reviewer"));
    expect(full.open?.openingCorrections).toEqual([expect.objectContaining({ currency: "YER", fromMinor: 950, toMinor: 1000 })]);
    expect((await shifts.readCanonicalShifts(await fx.session("operator"))).open?.openingCorrections).toEqual([
      { id: expect.any(Number), shiftId: shift.id, currency: "YER" }]);
  });

  it("grant and separation matrix: the opener and the previous closer never correct; every refusal writes nothing", async () => {
    const shift = await differing();
    const auditBefore = await audits(), opening = (await db.getOpenShiftWith(fx.pool))!.opening;
    for (const key of ["operator", "reader", "financeAll"] as const) await expect(correct(key, shift.id, { YER: "1000" })).rejects.toThrow(/CAPABILITY_DENIED/);
    await expect(reviews.commandCanonicalOpeningCorrection(await fx.session("reviewer"), { shiftId: shift.id, opening: { YER: "950" }, reason: "لا تغيير" }))
      .rejects.toMatchObject({ code: "invalid_opening_correction", status: 400 });
    await expect(reviews.commandCanonicalOpeningCorrection(await fx.session("reviewer"), { shiftId: shift.id, opening: { YER: "1000" }, reason: "ab" }))
      .rejects.toMatchObject({ code: "invalid_opening_correction", status: 400 });
    await expect(reviews.commandCanonicalOpeningCorrection(await fx.session("reviewer"), { shiftId: shift.id, opening: { YER: "x" }, reason: "سبب صالح" }))
      .rejects.toMatchObject({ code: "invalid_opening_correction", status: 400 });
    expect(await count("shift_opening_corrections", `shift_id=${shift.id}`)).toBe(0);
    expect((await db.getOpenShiftWith(fx.pool))!.opening).toEqual(opening);
    expect(await audits()).toBe(auditBefore);
    // A reviewer who opened the shift, or who closed the previous one, is refused; the owner may.
    await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: shift.id, counted: amounts(shift.expected), differenceReason: "synthetic" });
    const own = await open("operatorReviewer", { YER: "900" });
    await expect(correct("operatorReviewer", own.id, { YER: "950" })).rejects.toMatchObject({ code: "opening_correction_own_shift", status: 403 });
    await shifts.commandCanonicalShiftClose(await fx.session("operatorReviewer"), { id: own.id, counted: amounts(own.expected), differenceReason: "synthetic" });
    const next = await open("operator", { YER: "800" });
    await expect(correct("operatorReviewer", next.id, { YER: "900" })).rejects.toMatchObject({ code: "opening_correction_own_shift", status: 403 });
    expect(await correct("owner", next.id, { YER: "900" })).toMatchObject({ corrections: [expect.objectContaining({ fromMinor: 800, toMinor: 900 })] });
  });

  it("refuses a closed shift and a correction that would leave the drawer negative", async () => {
    const shift = await differing();
    await db.recordExpense({ category: "other" as const, partyId: null, payeeText: "SYN payee", amountMinor: 900, currency: "YER" as const,
      baseCurrency: "YER" as const, exchangeRate: 1, payableId: null, note: "SYN-CORRECTION-DRAWER", createdBy: ACCOUNTS.owner.username, actorRole: "admin" });
    expect((await db.getOpenShiftWith(fx.pool))!.expected.YER).toBe(50);
    await expect(correct("reviewer", shift.id, { YER: "800" })).rejects.toMatchObject({ code: "opening_correction_negative_drawer", status: 409 });
    expect(await count("shift_opening_corrections", `shift_id=${shift.id}`)).toBe(0);
    expect((await db.getOpenShiftWith(fx.pool))!.opening.YER).toBe(950);
    const current = (await db.getOpenShiftWith(fx.pool))!;
    await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: current.id, counted: amounts(current.expected), differenceReason: "synthetic" });
    await expect(correct("reviewer", shift.id, { YER: "1000" })).rejects.toMatchObject({ code: "opening_correction_shift_not_open", status: 409 });
    expect(await count("shift_opening_corrections", `shift_id=${shift.id}`)).toBe(0);
  });

  it("a correction racing the close is serialized: either it lands before the close or it is refused", async () => {
    const shift = await differing();
    const [corrected, closed] = await Promise.allSettled([
      correct("reviewer", shift.id, { YER: "1000" }),
      shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: shift.id, counted: { YER: "1000" }, differenceReason: "synthetic race" }),
    ]);
    expect(closed.status).toBe("fulfilled");
    const final = (await db.getShiftWith(fx.pool, shift.id))!;
    if (corrected.status === "fulfilled") {
      expect(final.opening.YER).toBe(1000);
      expect(final.expected.YER).toBe(1000);
      expect(await count("shift_opening_corrections", `shift_id=${shift.id}`)).toBe(1);
    } else {
      expect(corrected.reason).toMatchObject({ code: "opening_correction_shift_not_open" });
      expect(final.opening.YER).toBe(950);
      expect(await count("shift_opening_corrections", `shift_id=${shift.id}`)).toBe(0);
    }
  });

  it("corrections are append-only at the database", async () => {
    const shift = await differing();
    await correct("reviewer", shift.id, { YER: "1000" });
    const id = (await q("SELECT id FROM shift_opening_corrections WHERE shift_id=$1", [shift.id]))[0].id;
    await expect(q("UPDATE shift_opening_corrections SET to_minor = 5 WHERE id=$1", [id])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM shift_opening_corrections WHERE id=$1", [id])).rejects.toThrow(/append-only/);
  });
});
