/** Synthetic PostgreSQL only: actual batch writer, durable sessions and read snapshot. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-event-privacy-2026");
const db = await import("../../lib/db");
const lab = await import("../../lib/canonical-lab-orders");
const accounts = {
  owner: { username: "SYN-EVENT-OWNER", role: "admin" },
  viewer: { username: "SYN-EVENT-VIEW", role: "admin", patientScope: "all", grants: { "clinical.lab.view": true } },
  costs: { username: "SYN-EVENT-COST", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "finance.cost-prices.view": true } },
  expenses: { username: "SYN-EVENT-EXP", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "finance.expenses.view": true } },
  finance: { username: "SYN-EVENT-FIN", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "finance.cost-prices.view": true, "finance.expenses.view": true } },
  doctor: { username: "SYN-EVENT-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.lab.view": true, "finance.cost-prices.view": true, "finance.expenses.view": true } },
} as const;
let fx: CanonicalInventoryDatabase<keyof typeof accounts>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
let mine = 0, theirs = 0, voucher = "";
const total = 987654;
const legacySettlement = "تمت التسوية المالية المجمعة بسند صرف رقم SYN-LEGACY-VOUCHER بمبلغ 876543 YER";
const reversal = "أُبطل سند التسوية SYN-LEGACY-VOUCHER بقيد SYN-REVERSAL: historical reason 765432 YER";
const accounting = "تم الترحيل المحاسبي بحساب مصروف [SYN-5100] وذمم [SYN-2100]";
const history = () => q("SELECT * FROM lab_order_tracking ORDER BY id");
const read = async (key: keyof typeof accounts, id = mine) => lab.readCanonicalLabEvents(await fx.session(key), String(id));

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, accounts, "owner");
  const party = (await q("INSERT INTO parties(name,kind) VALUES('SYN event lab','lab') RETURNING id"))[0].id as number;
  await q("INSERT INTO cashier_shifts(opened_by, opening_yer, opening_sar, opening_usd) VALUES($1, 100000000, 100000000, 100000000)", [accounts.owner.username]); // 0128: drawer cash
  const order = async (suffix: string, doctor: number | null, amount: number) => {
    const patient = (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN event patient',$2) RETURNING id", [`SYN-EVENT-${suffix}`, doctor]))[0].id;
    const id = (await q(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,due_date,cost_minor,cost_currency,financial_status)
      VALUES($1,$2,'SYN event lab','Synthetic crown','delivered',CURRENT_DATE,$3,'YER','payable_created') RETURNING id`, [patient, party, amount]))[0].id as number;
    const payable = await db.createPayable({ partyId: party, category: "lab", description: `SYN RX-${id}`, amountMinor: amount,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, labOrderId: id, dueDate: null, createdBy: accounts.owner.username });
    expect(payable).not.toBeNull();
    await q("UPDATE lab_orders SET payable_id=$1 WHERE id=$2", [payable!.id, id]);
    return id;
  };
  mine = await order("MINE", fx.parties.doctor!, 123456);
  theirs = await order("THEIRS", null, total - 123456);
  const batch = await db.settleLabOrdersBatch({ partyId: party, orderIds: [mine, theirs], amountMinor: total,
    currency: "YER", baseCurrency: "YER", exchangeRate: 1, rates: { YER: 1, SAR: 140, USD: 535 }, note: null,
    createdBy: accounts.owner.username, actorRole: "admin" });
  expect(batch.ok).toBe(true);
  if (!batch.ok) throw new Error(`Synthetic full batch failed: ${batch.reason}`);
  voucher = batch.expense.voucherNumber;
  for (const [action, notes] of [
    ["status_change", "وصل سليمًا: tooth 14, shade A2"],
    ["accounting_posted", accounting],
    ["financial_settlement", legacySettlement],
    ["financial_settlement_reversed", reversal],
    ["unknown_historical_action", "SYN-UNKNOWN 654321 USD"],
  ]) await q("INSERT INTO lab_order_tracking(lab_order_id,action,notes,actor,actor_role) VALUES($1,$2,$3,$4,'admin')", [mine, action, notes, accounts.owner.username]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

it("fixture proves one real settlement spans two different patients and records the entire total on both", async () => {
  const rows = await q("SELECT t.notes,t.expense_id,l.patient_id FROM lab_order_tracking t JOIN lab_orders l ON l.id=t.lab_order_id WHERE t.expense_id IS NOT NULL ORDER BY l.id");
  expect(rows).toHaveLength(2);
  expect(rows[0].patient_id).not.toBe(rows[1].patient_id);
  expect(rows.map(row => row.notes)).toEqual([expect.stringContaining(String(total)), expect.stringContaining(String(total))]);
  expect(rows[0].expense_id).toBe(rows[1].expense_id);
});

it.each(["viewer", "expenses"] as const)("%s sees clinical history, not financial events or unknown payloads", async key => {
  const result = await read(key);
  expect(result.events.map(event => event.action)).toEqual(["status_change"]);
  expect(result.events[0].notes).toBe("وصل سليمًا: tooth 14, shade A2");
  expect(JSON.stringify(result)).not.toMatch(/987654|876543|765432|654321|SYN-5100|SYN-2100/);
});

it("all-scope costs alone preserves accounting but redacts expense/batch notes including legacy rows without expense_id", async () => {
  const result = await read("costs");
  expect(result.events.find(event => event.action === "accounting_posted")?.notes).toBe(accounting);
  expect(result.events.filter(event => event.action.startsWith("financial_")).map(event => event.notes)).toEqual([null, null, null]);
  expect(JSON.stringify(result)).not.toContain(voucher);
});

it("own-scope plus both finance grants cannot read a mixed-patient total, voucher, legacy note or reversal reason", async () => {
  const result = await read("doctor");
  expect(result.events.find(event => event.action === "accounting_posted")?.notes).toBe(accounting);
  expect(result.events.filter(event => event.action.startsWith("financial_")).map(event => event.notes)).toEqual([null, null, null]);
  for (const secret of [String(total), voucher, "876543", "765432", "SYN-LEGACY", "SYN-REVERSAL", "SYN-UNKNOWN"]) expect(JSON.stringify(result)).not.toContain(secret);
  await expect(read("doctor", theirs)).rejects.toMatchObject({ code: "lab_order_not_found", status: 404 });
});

it.each(["finance", "owner"] as const)("%s can read full classified financial history with both grants and all patient scope", async key => {
  const result = await read(key);
  expect(result.events.filter(event => event.action.startsWith("financial_")).map(event => event.notes))
    .toEqual([expect.stringContaining(`${total} YER`), legacySettlement, reversal]);
  expect(result.events.some(event => event.action === "unknown_historical_action")).toBe(false);
});

it("projection is read-only: no tracking, expense, allocation or lab-order row is modified", async () => {
  const snapshot = async () => ({ history: await history(), expenses: await q("SELECT * FROM expenses ORDER BY id"),
    allocations: await q("SELECT * FROM expense_payable_allocations ORDER BY id"), orders: await q("SELECT * FROM lab_orders ORDER BY id") });
  const before = await snapshot();
  for (const key of Object.keys(accounts) as (keyof typeof accounts)[]) await read(key);
  expect(await snapshot()).toEqual(before);
});
