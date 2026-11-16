/** M2 slice 94a (G4-1, G4-6, G4-8; contract section 9): the plan list on the canonical runtime,
 * real PostgreSQL, synthetic data only. Admitted by clinical.plans.view, finance.invoices.view or
 * finance.patient-ledger.view; each group by its own grant with a distinct sentinel (a hidden group
 * is absent, never nulled or zeroed); rows inside the patient scope with and without patientId;
 * a role label without grants refused; the legacy doctor_financial_view setting has no effect;
 * revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-plan-list-secret-94a");
const db = await import("../../lib/db");
const plans = await import("../../lib/canonical-plan-list");

const CLINICAL = { "clinical.plans.view": true };
const PRICES = { "finance.invoices.view": true };
const ACCOUNT = { "finance.patient-ledger.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PL-OWNER", role: "admin" },
  clinical: { username: "SYN-PL-CLIN", role: "doctor", patientScope: "all", grants: CLINICAL },
  prices: { username: "SYN-PL-PRICE", role: "accountant", patientScope: "all", grants: PRICES },
  account: { username: "SYN-PL-ACCT", role: "accountant", patientScope: "all", grants: ACCOUNT },
  full: { username: "SYN-PL-FULL", role: "reception", patientScope: "all", grants: { ...CLINICAL, ...PRICES, ...ACCOUNT } },
  label: { username: "SYN-PL-LABEL", role: "admin", patientScope: "all", grants: {} },
  other: { username: "SYN-PL-OTHER", role: "reception", patientScope: "all", grants: { "clinical.visits.document": true } },
  doctor: { username: "SYN-PL-DR", role: "doctor", doctor: true, patientScope: "own", grants: CLINICAL },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const ids = { mine: 0, other: 0, minePlan: 0, otherPlan: 0 };
type Listed = { plans: Array<Record<string, unknown> & { id: number; items?: Array<Record<string, unknown>> }>; canSeeFinancial: boolean; projection: Record<string, boolean> };
const read = async (key: Key, patientId: number | null) => await plans.readCanonicalPlanList(await fx.session(key), patientId === null ? null : String(patientId)) as unknown as Listed;

// One sentinel per group: the clinical text, the prices amounts, the account reminder date.
// The item price (77777) shows only with the clinical group too; the later instalment (66666) is
// schedule detail; the agreement total (88888) shows with either money grant (G4-1, as the slice 88
// account read); the next due amount (22222) is in the account progress, as the ledger summary.
const SENTINEL = { clinical: ["SYN-PL-TITLE", "SYN-PL-NOTE", "SYN-PL-ITEM"], prices: ["66666"], account: ["2031-03-03"] } as const;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN PL patient',$2) RETURNING id", [number, doctor]))[0].id as number;
  ids.mine = await patient("SYN-PL-1", fx.parties.doctor!);
  ids.other = await patient("SYN-PL-2", null);
  const plan = async (patientId: number) => {
    const id = await db.createPlan({ patientId, title: "SYN-PL-TITLE", totalMinor: 88888, baseCurrency: "YER", startDate: "2026-11-01", note: "SYN-PL-NOTE",
      createdBy: "SYN-PL-OWNER", installments: [{ number: 1, dueDate: "2027-01-01", amountMinor: 22222 }, { number: 2, dueDate: "2027-06-01", amountMinor: 66666 }] });
    if (!id) throw new Error("SYN plan missing");
    await q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor) VALUES($1,'SYN-PL-ITEM',1,77777)", [id]);
    await q("UPDATE treatment_plans SET last_reminder_at='2031-03-03T03:03:03Z' WHERE id=$1", [id]);
    await q("UPDATE plan_installments SET last_reminder_at='2031-03-03T03:03:03Z' WHERE plan_id=$1", [id]);
    return id;
  };
  ids.minePlan = await plan(ids.mine);
  ids.otherPlan = await plan(ids.other);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("the plan list", () => {
  it("each group by its own grant: a hidden group's sentinel and keys are absent", async () => {
    const cases: Array<[Key, { clinical: boolean; prices: boolean; account: boolean }]> = [
      ["clinical", { clinical: true, prices: false, account: false }],
      ["prices", { clinical: false, prices: true, account: false }],
      ["account", { clinical: false, prices: false, account: true }],
      ["full", { clinical: true, prices: true, account: true }],
      ["owner", { clinical: true, prices: true, account: true }],
    ];
    for (const [key, expected] of cases) {
      const listed = await read(key, ids.mine);
      expect(listed.projection, key).toEqual(expected);
      expect(listed.canSeeFinancial, key).toBe(expected.prices && expected.account);
      expect(listed.plans.map(plan => plan.id), key).toEqual([ids.minePlan]);
      const [plan] = listed.plans, text = JSON.stringify(listed);
      for (const group of ["clinical", "prices", "account"] as const) {
        for (const sentinel of SENTINEL[group]) expect(text.includes(sentinel), `${key} ${group} ${sentinel}`).toBe(expected[group]);
      }
      expect(text.includes("77777"), `${key} item price`).toBe(expected.clinical && expected.prices);
      expect(text.includes("88888"), `${key} total`).toBe(expected.prices || expected.account);
      expect(text.includes("22222"), `${key} next due`).toBe(expected.prices || expected.account);
      expect(plan.title, key).toBe(expected.clinical ? "SYN-PL-TITLE" : `خطة مالية #${ids.minePlan}`);
      expect("items" in plan, key).toBe(expected.clinical);
      // Every reader keeps the picker's structure (legacy withoutPlanPayments): identities, never amounts.
      expect(plan.agreementApproved, key).toBe(false);
      expect(plan.hasInstallments, key).toBe(true);
      const schedule = plan.installments as Array<Record<string, unknown>>;
      expect(schedule.map(row => typeof row.id), key).toEqual(["number", "number"]);
      expect(schedule.every(row => "amountMinor" in row && "dueDate" in row), key).toBe(expected.prices);
      if (!expected.prices) expect(schedule.every(row => Object.keys(row).join() === "id"), key).toBe(true);
      expect("totalMinor" in plan, key).toBe(expected.prices || expected.account);
      expect("paidMinor" in plan && "progress" in plan, key).toBe(expected.account);
      if (expected.clinical) expect("unitPriceMinor" in plan.items![0], key).toBe(expected.prices);
      // A hidden group is absent, never present as null or zero.
      for (const field of ["totalMinor", "paidMinor", "note", "items", "lastReminderAt"]) {
        if (field in plan) expect(plan[field], `${key} ${field}`).not.toBeNull();
      }
    }
  });

  it("rows inside the patient scope: own sees only its patients with and without patientId; all sees every plan", async () => {
    expect((await read("doctor", ids.mine)).plans.map(plan => plan.id)).toEqual([ids.minePlan]);
    expect(await refusal(read("doctor", ids.other))).toMatchObject({ code: "patient_not_found" });
    const ownActive = (await read("doctor", null)).plans.map(plan => plan.id);
    expect(ownActive).toContain(ids.minePlan);
    expect(ownActive).not.toContain(ids.otherPlan);
    const allActive = (await read("full", null)).plans.map(plan => plan.id);
    expect(allActive).toEqual(expect.arrayContaining([ids.minePlan, ids.otherPlan]));
    expect(await refusal(read("full", -1 as never))).toMatchObject({ code: "invalid_patient_query" });
  });

  it("a role label without grants and an unrelated grant are refused", async () => {
    for (const key of ["label", "other"] as const) expect(await refusal(read(key, ids.mine)), key).toMatchObject(denied);
  });

  it("G4-6: the legacy doctor_financial_view setting has no effect", async () => {
    await q("INSERT INTO settings(key,value) VALUES('workflow.doctor_financial_view','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    db.invalidateSettingsCache();
    try {
      for (const key of ["doctor", "clinical"] as const) {
        const listed = await read(key, ids.mine), text = JSON.stringify(listed);
        expect(listed.projection, key).toEqual({ clinical: true, prices: false, account: false });
        for (const sentinel of [...SENTINEL.prices, ...SENTINEL.account, "77777", "88888", "22222"]) expect(text, key).not.toContain(sentinel);
      }
    } finally {
      await q("DELETE FROM settings WHERE key='workflow.doctor_financial_view'");
      db.invalidateSettingsCache();
    }
  });

  it("revocation: a removed grant refuses the next read; a narrowed grant drops its group", async () => {
    await fx.setGrants("full", {}, { patientScope: "all" });
    try { expect(await refusal(read("full", ids.mine))).toMatchObject(denied); }
    finally { await fx.setGrants("full", { ...CLINICAL, ...PRICES, ...ACCOUNT }, { patientScope: "all" }); }
    await fx.setGrants("full", { ...CLINICAL, ...ACCOUNT }, { patientScope: "all" });
    try {
      const listed = await read("full", ids.mine);
      expect(listed.projection).toEqual({ clinical: true, prices: false, account: true });
      for (const sentinel of [...SENTINEL.prices, "77777"]) expect(JSON.stringify(listed)).not.toContain(sentinel);
    } finally { await fx.setGrants("full", { ...CLINICAL, ...PRICES, ...ACCOUNT }, { patientScope: "all" }); }
    expect((await read("full", ids.mine)).projection).toEqual({ clinical: true, prices: true, account: true });
  });
});
