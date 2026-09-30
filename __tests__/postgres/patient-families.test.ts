import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (PAT-4) العائلات والضامن على PostgreSQL 18 الحقيقي.
 *
 * قرار المالك: الضامن معلومةٌ وكشفٌ فقط — لا صفّ مالٍ يُنشأ أو يتغيّر، ورصيد العائلة مجموع أرصدة
 * أفرادها الكانونية لكل عملةٍ على حدة. وكل كتابةٍ بسطر تدقيقٍ في معاملتها، والدمج والحذف يعملان.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, getPool, resetPoolForTesting, createPatientFamily, linkPatientToFamily, unlinkPatientFromFamily,
  setFamilyGuarantor, updateFamilyDetails, getPatientFamilyRecord, familyMemberBalances, findFamiliesByPhone,
  searchPatientFamilies, familyIdOfPatient, ledgerBalancesByCurrency, patientLedger, patientPlanCurrencies,
  mergeDuplicatePatient, deletePatientCascade, resetClinicData,
  backupSnapshotSqlLines,
} = await import("../../lib/db");
const { familyTotals } = await import("../../lib/patient-families");
const { CURRENCIES } = await import("../../lib/money");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let seq = 0;
async function patient(name: string, phone: string | null = null): Promise<number> {
  seq += 1;
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id`,
    [`FAM-${seq}`, name, phone],
  );
  return row.id;
}

const actor = { actor: "reception1", actorRole: "reception" };
let shiftId = 0;

async function invoice(patientId: number, minor: number, currency: "YER" | "SAR" | "USD"): Promise<number> {
  seq += 1;
  const [row] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
     VALUES ($1, $2, $3, 0, $4, 't') RETURNING id`, [`INV-F${seq}`, patientId, minor, currency]);
  return row.id;
}

async function payment(patientId: number, invoiceId: number, minor: number, currency: "YER" | "SAR" | "USD"): Promise<void> {
  seq += 1;
  await q(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                           base_amount_minor, base_currency, method, created_by)
     VALUES ($1, $2, $3, $4, 'payment', $5, $6, 1, $5, $6, 'cash', 't')`,
    [`R-F${seq}`, patientId, invoiceId, shiftId, minor, currency]);
}

/** بصمة كل جداول المال — أي صفٍّ يُنشأ أو يتغيّر يغيّرها. */
async function moneyFingerprint(): Promise<Record<string, string>> {
  const tables = ["payments", "invoices", "invoice_items", "journal_manual", "journal_manual_lines",
    "patient_opening_balances", "treatment_plans", "cashier_shifts", "payables", "expenses"];
  const result: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await q<{ n: string; h: string | null }>(
      `SELECT count(*)::text AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM ${table} t`);
    result[table] = `${row.n}:${row.h ?? ""}`;
  }
  return result;
}

async function canonicalBalances(patientId: number) {
  const [ledger, plans] = await Promise.all([patientLedger(patientId), patientPlanCurrencies(patientId)]);
  return ledgerBalancesByCurrency(patientId, ledger, plans);
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const [shift] = await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by) VALUES ('fam') RETURNING id`);
  shiftId = shift.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("PAT-4 families — writes and audit", () => {
  it("creates a family with a patient guarantor and members; links, re-roles, unlinks; every write audited", async () => {
    const father = await patient("عبدالله الحكيمي", "777100200");
    const son = await patient("سالم عبدالله الحكيمي");
    const daughter = await patient("مريم عبدالله الحكيمي");

    const created = await createPatientFamily({
      name: "عائلة الحكيمي", note: null, guarantor: { kind: "patient", patientId: father },
      members: [{ patientId: father, role: "father" }, { patientId: son, role: "son" }],
    }, actor);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const familyId = created.family.id;
    expect(created.family.guarantor).toMatchObject({ kind: "patient", patientId: father, name: "عبدالله الحكيمي" });
    expect(created.family.members.map((m) => [m.id, m.role])).toEqual([[father, "father"], [son, "son"]]);

    const linked = await linkPatientToFamily({ familyId, patientId: daughter, role: "daughter" }, actor);
    expect(linked.ok && linked.family.members).toHaveLength(3);
    /* تغيير الصلة لفردٍ قائم — مسموح ومدقَّق؛ وتكرار الصلة نفسها لا يكتب سطرًا. */
    expect((await linkPatientToFamily({ familyId, patientId: daughter, role: "other" }, actor)).ok).toBe(true);
    expect((await linkPatientToFamily({ familyId, patientId: daughter, role: "other" }, actor)).ok).toBe(true);

    const unlinked = await unlinkPatientFromFamily({ familyId, patientId: daughter }, actor);
    expect(unlinked.ok && unlinked.family.members.map((m) => m.id)).toEqual([father, son]);
    expect(await familyIdOfPatient(daughter)).toBeNull();
    const [row] = await q<{ family_role: string | null }>(`SELECT family_role FROM patients WHERE id = $1`, [daughter]);
    expect(row.family_role).toBeNull();

    const external = await setFamilyGuarantor({ familyId, guarantor: { kind: "external", name: "خالد الحكيمي", phone: "967733000111" } }, actor);
    expect(external.ok && external.family.guarantor).toMatchObject({ kind: "external", name: "خالد الحكيمي", phone: "967733000111", patientId: null });
    const renamed = await updateFamilyDetails({ familyId, name: "آل الحكيمي", note: "الأب يسدد عن الجميع" }, actor);
    expect(renamed.ok && renamed.family).toMatchObject({ name: "آل الحكيمي", note: "الأب يسدد عن الجميع" });

    const audit = await q<{ action: string; entity: string; entity_id: string }>(
      `SELECT action, entity, entity_id FROM audit_log WHERE action LIKE 'family.%' ORDER BY id`);
    expect(audit.map((a) => a.action)).toEqual([
      "family.create", "family.link", "family.link", "family.link", "family.link", "family.unlink", "family.guarantor", "family.rename",
    ]);
    expect(audit[0]).toMatchObject({ entity: "family", entity_id: String(familyId) });
    expect(audit[5]).toMatchObject({ entity: "patient", entity_id: String(daughter) });
  });

  it("refuses silent moves between families (409 reason) and rolls the whole create back", async () => {
    const a = await patient("فرد أول");
    const b = await patient("فرد ثان");
    const first = await createPatientFamily({ name: "عائلة أ", note: null, guarantor: { kind: "none" }, members: [{ patientId: a, role: null }] }, actor);
    if (!first.ok) throw new Error("create failed");
    const families = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM patient_families`))[0].n);

    const clash = await createPatientFamily({
      name: "عائلة ب", note: null, guarantor: { kind: "none" },
      members: [{ patientId: b, role: null }, { patientId: a, role: null }],
    }, actor);
    expect(clash).toMatchObject({ ok: false, reason: "already_in_family", patientId: a });
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM patient_families`))[0].n)).toBe(families);
    expect(await familyIdOfPatient(b)).toBeNull();

    const second = await createPatientFamily({ name: "عائلة ب", note: null, guarantor: { kind: "none" }, members: [] }, actor);
    if (!second.ok) throw new Error("create failed");
    expect(await linkPatientToFamily({ familyId: second.family.id, patientId: a, role: "son" }, actor))
      .toMatchObject({ ok: false, reason: "already_in_family" });
    expect(await unlinkPatientFromFamily({ familyId: second.family.id, patientId: a }, actor))
      .toMatchObject({ ok: false, reason: "not_member" });
    expect(await linkPatientToFamily({ familyId: 999_999, patientId: a, role: null }, actor))
      .toMatchObject({ ok: false, reason: "family_not_found" });
    expect(await linkPatientToFamily({ familyId: second.family.id, patientId: 999_999, role: null }, actor))
      .toMatchObject({ ok: false, reason: "patient_not_found" });
    expect(await setFamilyGuarantor({ familyId: second.family.id, guarantor: { kind: "patient", patientId: 999_999 } }, actor))
      .toMatchObject({ ok: false, reason: "guarantor_not_found" });
  });

  it("unlinking the last member leaves an empty family (not deleted)", async () => {
    const only = await patient("وحيد");
    const created = await createPatientFamily({ name: "عائلة فرد", note: null, guarantor: { kind: "none" }, members: [{ patientId: only, role: "other" }] }, actor);
    if (!created.ok) throw new Error("create failed");
    const result = await unlinkPatientFromFamily({ familyId: created.family.id, patientId: only }, actor);
    expect(result.ok && result.family.members).toEqual([]);
    expect(await getPatientFamilyRecord(created.family.id)).toMatchObject({ id: created.family.id, members: [] });
  });

  it("the database refuses two guarantor kinds at once", async () => {
    const g = await patient("ضامن");
    await expect(q(
      `INSERT INTO patient_families (name, guarantor_patient_id, guarantor_name, created_by) VALUES ('x', $1, 'y', 't')`, [g],
    )).rejects.toMatchObject({ code: "23514" });
  });
});

describe("PAT-4 families — money is read, never written", () => {
  it("family balance = sum of each member's canonical per-currency balance; no money row created or changed", async () => {
    const mother = await patient("أم الشرعبي");
    const kid = await patient("ابن الشرعبي");
    const credit = await patient("ابنة الشرعبي");
    const inv1 = await invoice(mother, 50_000, "YER");
    await payment(mother, inv1, 20_000, "YER");
    await invoice(kid, 30_000, "YER");
    await invoice(kid, 10_000, "SAR");
    const inv3 = await invoice(credit, 5_000, "YER");
    await payment(credit, inv3, 8_000, "YER"); // دفعةٌ زائدة: رصيدٌ دائن

    const before = await moneyFingerprint();
    const created = await createPatientFamily({
      name: "عائلة الشرعبي", note: null, guarantor: { kind: "external", name: "العم", phone: null },
      members: [{ patientId: mother, role: "mother" }, { patientId: kid, role: "son" }, { patientId: credit, role: "daughter" }],
    }, actor);
    if (!created.ok) throw new Error("create failed");
    await setFamilyGuarantor({ familyId: created.family.id, guarantor: { kind: "patient", patientId: mother } }, actor);
    await unlinkPatientFromFamily({ familyId: created.family.id, patientId: credit }, actor);
    await linkPatientToFamily({ familyId: created.family.id, patientId: credit, role: "daughter" }, actor);

    const ids = [mother, kid, credit];
    const balances = await familyMemberBalances(ids);
    for (const id of ids) {
      const canonical = await canonicalBalances(id);
      const expected = CURRENCIES.map((currency) => ({ currency, balanceMinor: canonical[currency].dueMinor }))
        .filter((line) => line.balanceMinor !== 0);
      expect(balances.get(id)).toEqual(expected);
    }
    expect(balances.get(mother)).toEqual([{ currency: "YER", balanceMinor: 30_000 }]);
    expect(balances.get(kid)).toEqual([{ currency: "YER", balanceMinor: 30_000 }, { currency: "SAR", balanceMinor: 10_000 }]);
    expect(balances.get(credit)).toEqual([{ currency: "YER", balanceMinor: -3_000 }]);

    const totals = familyTotals(ids.map((id) => ({ balances: balances.get(id) ?? [] })));
    const expectedTotals = CURRENCIES.map((currency) => ({
      currency,
      balanceMinor: ids.reduce((sum, id) => sum + (balances.get(id)?.find((l) => l.currency === currency)?.balanceMinor ?? 0), 0),
    })).filter((line) => ids.some((id) => balances.get(id)?.some((l) => l.currency === line.currency)));
    expect(totals).toEqual(expectedTotals);
    expect(totals).toEqual([{ currency: "YER", balanceMinor: 57_000 }, { currency: "SAR", balanceMinor: 10_000 }]);

    expect(await moneyFingerprint()).toEqual(before);
  });
});

describe("PAT-4 families — suggestions and search", () => {
  it("a phone matching a member (any stored form) suggests the family; search finds it by name or member", async () => {
    const member = await patient("علي الأغبري", "967771234567");
    const created = await createPatientFamily({ name: "عائلة الأغبري", note: null, guarantor: { kind: "none" }, members: [{ patientId: member, role: "father" }] }, actor);
    if (!created.ok) throw new Error("create failed");
    const suggestions = await findFamiliesByPhone("771234567");
    expect(suggestions).toEqual([expect.objectContaining({
      familyId: created.family.id, name: "عائلة الأغبري", memberCount: 1,
      matchedBy: { patientId: member, fullName: "علي الأغبري", role: "father" },
    })]);
    expect(await findFamiliesByPhone("700000000")).toEqual([]);
    expect((await searchPatientFamilies("الاغبري")).map((f) => f.id)).toContain(created.family.id);
    expect((await searchPatientFamilies("علي")).map((f) => f.id)).toContain(created.family.id);

    // Old records can still store the local form while a newly saved patient stores 967… .
    await q(`UPDATE patients SET phone = '771234567' WHERE id = $1`, [member]);
    expect((await findFamiliesByPhone("967771234567")).map((f) => f.familyId)).toContain(created.family.id);
  });
});

describe("PAT-4 families — SQL backup", () => {
  it("defers a registered guarantor until the patient and family rows have both been restored", async () => {
    const guarantor = await patient("ضامن النسخة");
    const created = await createPatientFamily({
      name: "عائلة النسخة", note: null, guarantor: { kind: "patient", patientId: guarantor },
      members: [{ patientId: guarantor, role: "father" }],
    }, actor);
    if (!created.ok) throw new Error("create failed");
    const lines: string[] = [];
    for await (const line of backupSnapshotSqlLines(getPool())) lines.push(line);
    const familyInsert = lines.find((line) => line.startsWith("INSERT INTO patient_families ") && line.includes(`VALUES (${created.family.id},`));
    expect(familyInsert).toMatch(/"guarantor_patient_id".*VALUES \(\d+, [^,]+, NULL,/);
    const replay = `UPDATE patient_families SET guarantor_patient_id = ${guarantor} WHERE id = ${created.family.id};\n`;
    expect(lines.indexOf(replay)).toBeGreaterThan(lines.findIndex((line) => line.startsWith("INSERT INTO patients ")));
  });
});

describe("PAT-4 families — merge, delete and reset keep working", () => {
  it("merge: the duplicate's guarantor role moves to the original and its membership is inherited", async () => {
    const original = await patient("محمد القدسي");
    const duplicate = await patient("محمد القدسى");
    const sibling = await patient("أخ القدسي");
    const created = await createPatientFamily({
      name: "عائلة القدسي", note: null, guarantor: { kind: "patient", patientId: duplicate },
      members: [{ patientId: duplicate, role: "father" }, { patientId: sibling, role: "sibling" }],
    }, actor);
    if (!created.ok) throw new Error("create failed");

    const merged = await mergeDuplicatePatient(duplicate, original, { actor: "admin" });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.moved["patient_families.guarantor_patient_id"]).toBe(1);
    expect(merged.moved["patients.family_id"]).toBe(1);
    const family = await getPatientFamilyRecord(created.family.id);
    expect(family?.guarantor).toMatchObject({ kind: "patient", patientId: original });
    expect(family?.members.map((m) => [m.id, m.role]).sort()).toEqual([[original, "father"], [sibling, "sibling"]].sort());
  });

  it("merge: an original already in a family keeps it (no silent replacement)", async () => {
    const original = await patient("أصل");
    const duplicate = await patient("مكرر");
    const a = await createPatientFamily({ name: "عائلة الأصل", note: null, guarantor: { kind: "none" }, members: [{ patientId: original, role: "son" }] }, actor);
    const b = await createPatientFamily({ name: "عائلة المكرر", note: null, guarantor: { kind: "none" }, members: [{ patientId: duplicate, role: "father" }] }, actor);
    if (!a.ok || !b.ok) throw new Error("create failed");
    const merged = await mergeDuplicatePatient(duplicate, original, { actor: "admin" });
    expect(merged.ok).toBe(true);
    expect(await familyIdOfPatient(original)).toBe(a.family.id);
    const [row] = await q<{ family_role: string }>(`SELECT family_role FROM patients WHERE id = $1`, [original]);
    expect(row.family_role).toBe("son");
    expect((await getPatientFamilyRecord(b.family.id))?.members).toEqual([]);
  });

  it("delete: a guarantor or member without history can still be deleted; the family stays", async () => {
    const guarantor = await patient("ضامن يُحذف");
    const member = await patient("فرد يُحذف");
    const created = await createPatientFamily({
      name: "عائلة الحذف", note: null, guarantor: { kind: "patient", patientId: guarantor },
      members: [{ patientId: guarantor, role: "father" }, { patientId: member, role: "son" }],
    }, actor);
    if (!created.ok) throw new Error("create failed");
    expect((await deletePatientCascade(guarantor, { actor: "admin" })).ok).toBe(true);
    expect((await deletePatientCascade(member, { actor: "admin" })).ok).toBe(true);
    expect(await getPatientFamilyRecord(created.family.id)).toMatchObject({
      guarantor: { kind: "none" }, members: [],
    });
  });

  it("delete: the financial guard still refuses a member with money — family membership changes nothing", async () => {
    const member = await patient("فرد عليه مال");
    await invoice(member, 1_000, "YER");
    const created = await createPatientFamily({ name: "عائلة المال", note: null, guarantor: { kind: "none" }, members: [{ patientId: member, role: "son" }] }, actor);
    if (!created.ok) throw new Error("create failed");
    expect(await deletePatientCascade(member, { actor: "admin" })).toMatchObject({ ok: false, reason: "has_financial_history" });
    expect(await familyIdOfPatient(member)).toBe(created.family.id);
  });

  it("clinic reset wipes the families table", async () => {
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM patient_families`))[0].n)).toBeGreaterThan(0);
    const result = await resetClinicData({ actor: "owner", actorRole: "admin" }, async () => ({ ok: true, backupId: null }));
    expect(result.ok).toBe(true);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM patient_families`))[0].n)).toBe(0);
  });
});
