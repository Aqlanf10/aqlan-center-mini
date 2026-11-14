/**
 * 0129 shift opening reviews (docs/finance/SHIFT_OPENING_REVIEWS_0129.md; owner #483 6831365228 item 1).
 * Synthetic PostgreSQL database only. The opening difference against the previous close is never silent,
 * never a cash movement, never a change to the previous close; it is reviewed once by a person.
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
const { OpeningDifferenceNoteRequired, CASHIER_SHIFT_LIFECYCLE_LOCK } = await import("../../lib/shift-opening-reviews");

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
const audits = () => count("audit_log", "action IN ('shift.open','shift.close','shift.opening_review')");
const moneySnapshot = async () => (await q(`SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) AS payments,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM expenses e) AS expenses,
  (SELECT count(*) FROM journal_manual) AS manual_journal`))[0];
const amounts = (a: CashierShift["expected"]) => ({ YER: toInputAmount(a.YER, "YER"), SAR: toInputAmount(a.SAR, "SAR"), USD: toInputAmount(a.USD, "USD") });
const open = async (key: Key, opening: Record<string, string>, openingDifferenceNote?: string) =>
  shifts.commandCanonicalShiftOpen(await fx.session(key), { opening, openingDifferenceNote, openedBy: "forged-actor" });
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

  it("refuses a mismatch without a note and writes nothing at all", async () => {
    await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000", SAR: "20" });
    const shiftsBefore = await count("cashier_shifts"), auditBefore = await audits();
    await expect(open("operator", { YER: "950", SAR: "20", USD: "5" })).rejects.toMatchObject({
      code: "opening_difference_note_required", status: 409,
      differences: [
        { currency: "YER", differenceMinor: -50 },
        { currency: "USD", differenceMinor: 500 },
      ],
    });
    await expect(open("operator", { YER: "950", SAR: "20" }, "  ")).rejects.toMatchObject({ code: "opening_difference_note_required" });
    await expect(open("operator", { YER: "950", SAR: "20" }, "ab")).rejects.toMatchObject({ code: "invalid_shift", status: 400 });
    expect(await count("cashier_shifts")).toBe(shiftsBefore);
    expect(await count("shift_opening_reviews")).toBe(0);
    expect(await audits()).toBe(auditBefore);
    // The refusal never discloses the previous count (blind opening).
    const refusal = await open("operator", { YER: "950" }, undefined).catch(error => error);
    expect(JSON.stringify(refusal.differences)).not.toMatch(/previousCounted/);
    expect(refusal.message).toMatch(/نقص/);
  });

  it("with a note: opens, records one row per differing currency in the same transaction, moves no money, keeps the previous close", async () => {
    await open("operator", { YER: "1000" });
    const previous = (await closeCounting("operator", { YER: "1000", SAR: "20" }))!;
    const previousRow = await shiftRow(previous.id), money = await moneySnapshot(), auditBefore = await audits();
    const shift = await open("operator", { YER: "950", SAR: "20", USD: "5" }, "  وجدت الدرج ناقصًا عند الوصول  ");
    expect(shift.opening).toEqual({ YER: 950, SAR: 2000, USD: 500 });
    expect(shift.expected).toEqual({ YER: 950, SAR: 2000, USD: 500 });
    expect(shift.openingReviews).toEqual([
      expect.objectContaining({ currency: "YER", previousShiftId: previous.id, previousCountedMinor: 1000, openingMinor: 950, differenceMinor: -50,
        openingNote: "وجدت الدرج ناقصًا عند الوصول", detectedBy: ACCOUNTS.operator.username, reviewedAt: null }),
      expect.objectContaining({ currency: "USD", previousCountedMinor: 0, openingMinor: 500, differenceMinor: 500 }),
    ]);
    expect(await count("shift_opening_reviews", `shift_id=${shift.id}`)).toBe(2);
    expect(await audits()).toBe(auditBefore + 1);
    expect((await q("SELECT details FROM audit_log WHERE action='shift.open' ORDER BY id DESC LIMIT 1"))[0].details)
      .toMatchObject({ فروق_الافتتاح: [{ العملة: "YER", الفرق: -50 }, { العملة: "USD", الفرق: 500 }], ملاحظة_الافتتاح: "وجدت الدرج ناقصًا عند الوصول" });
    expect(await moneySnapshot()).toEqual(money);
    expect(await shiftRow(previous.id)).toEqual(previousRow);
    const read = await shifts.readCanonicalShifts(await fx.session("reader"));
    expect(read.open?.openingReviews).toHaveLength(2);
    expect(read.pendingOpeningReviews).toBeGreaterThanOrEqual(2);
  });

  it("rolls the opening and its review rows back together when the audit fails", async () => {
    await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000" });
    const shiftsBefore = await count("cashier_shifts"), rowsBefore = await count("shift_opening_reviews");
    await q("ALTER TABLE audit_log ADD CONSTRAINT synthetic_open_audit_failure CHECK (action <> 'shift.open') NOT VALID");
    try { await expect(open("operator", { YER: "900" }, "فرق اصطناعي")).rejects.toThrow(); }
    finally { await q("ALTER TABLE audit_log DROP CONSTRAINT synthetic_open_audit_failure"); }
    expect(await count("cashier_shifts")).toBe(shiftsBefore);
    expect(await count("shift_opening_reviews")).toBe(rowsBefore);
  });

  it("an unknown previous count needs a note when the opening is not zero", async () => {
    await q(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at, counted_yer, counted_sar, counted_usd)
             VALUES ('SYN-LEGACY-CLOSE', 'closed', 'SYN-LEGACY-CLOSE', now(), NULL, NULL, NULL)`);
    const legacy = (await q("SELECT id FROM cashier_shifts WHERE opened_by='SYN-LEGACY-CLOSE'"))[0].id;
    await expect(open("operator", { SAR: "5" })).rejects.toMatchObject({
      code: "opening_difference_note_required", differences: [{ currency: "SAR", differenceMinor: null, previousCountKnown: false }] });
    const shift = await open("operator", { SAR: "5" }, "إقفال قديم بلا عدّ");
    expect(shift.openingReviews).toEqual([expect.objectContaining({ currency: "SAR", previousShiftId: legacy, previousCountedMinor: null, differenceMinor: null, openingMinor: 500 })]);
  });

  it("the legacy writer keeps the same rule: refusal without a note when required, recorded rows otherwise", async () => {
    const base = await open("operator", { YER: "1000" });
    await closeCounting("operator", { YER: "1000" });
    expect(base.id).toBeGreaterThan(0);
    const shiftsBefore = await count("cashier_shifts");
    await expect(db.openShift({ openedBy: "SYN-LEGACY-OPENER", opening: { YER: 500, SAR: 0, USD: 0 }, requireOpeningDifferenceNote: true }))
      .rejects.toBeInstanceOf(OpeningDifferenceNoteRequired);
    expect(await count("cashier_shifts")).toBe(shiftsBefore);
    const opened = (await db.openShift({ openedBy: "SYN-LEGACY-OPENER", opening: { YER: 500, SAR: 0, USD: 0 } }))!;
    expect(opened.openingReviews).toEqual([expect.objectContaining({ currency: "YER", differenceMinor: -500, openingNote: null })]);
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
        open("operator", { YER: "900" }, "فرق اصطناعي"),
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
    const shift = await open(opener, { YER: "1200" }, "زيادة غير مفسَّرة");
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

  it("lists pending and all rows for a shift viewer", async () => {
    const row = await pendingRow();
    const pending = await reviews.readCanonicalOpeningReviews(await fx.session("reader"), { status: "pending" });
    expect(pending.reviews.map(r => r.id)).toContain(row.id);
    expect(pending.reviews.every(r => r.reviewedAt === null)).toBe(true);
    await review("reviewer", row.id);
    const after = await reviews.readCanonicalOpeningReviews(await fx.session("reader"), { status: "pending" });
    expect(after.reviews.map(r => r.id)).not.toContain(row.id);
    expect((await reviews.readCanonicalOpeningReviews(await fx.session("reader"), { status: "all" })).reviews.map(r => r.id)).toContain(row.id);
  });

  it("the table is append-only at the database", async () => {
    const row = await pendingRow();
    await expect(q("UPDATE shift_opening_reviews SET difference_minor = 1 WHERE id=$1", [row.id])).rejects.toThrow(/append-only/);
    await expect(q("UPDATE shift_opening_reviews SET opening_note = 'تعديل' WHERE id=$1", [row.id])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM shift_opening_reviews WHERE id=$1", [row.id])).rejects.toThrow(/لا تُحذف/);
    await expect(q("UPDATE shift_opening_reviews SET review_reason='سبب' WHERE id=$1", [row.id])).rejects.toThrow(/shift_opening_reviews_review_valid/);
    await review("reviewer", row.id);
    await expect(q("UPDATE shift_opening_reviews SET review_reason='سبب آخر' WHERE id=$1", [row.id])).rejects.toThrow(/مرة واحدة/);
    await expect(q("DELETE FROM cashier_shifts WHERE id=$1", [row.shiftId])).rejects.toThrow();
  });
});
