import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (PAT-4) العائلات والضامن على التطبيق المبني: من يكتب (الاستقبال والإدارة وحدهما)، ومن يرى
 * الأرصدة (قاعدة مال المريض الواحد)، وعزل الطبيب داخل العائلة، وأن الكاشير والمحاسب يطبعان كشف
 * العائلة ولا يصلان إلى مساراتها — وكل رفضٍ برسالة عربية وحدها.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let ownedId = 0;   // مريضٌ للطبيب أ
let otherId = 0;   // مريضٌ ليس له
let loneId = 0;    // مريضٌ بلا عائلة
let familyId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const bodyOf = async (response: Response) => await response.json() as Record<string, unknown>;

/** رسالة عربية وحدها — لا حقل غيرها ولا نصّ استثناء. */
async function expectArabicOnly(response: Response, status: number) {
  expect(response.status).toBe(status);
  const body = await bodyOf(response);
  expect(Object.keys(body)).toEqual(["message"]);
  expect(body.message).toMatch(/[؀-ۿ]/);
  expect(String(body.message)).not.toMatch(/error|exception|stack|select|insert|null|undefined/i);
}

interface FamilyViewBody {
  id: number;
  members: { id: number; balances?: { currency: string; balanceMinor: number }[] }[];
  canSeeMoney: boolean;
  totals?: { currency: string; balanceMinor: number }[];
  canEdit: boolean;
}

async function setDoctorPayments(on: boolean) {
  const { rows: [user] } = await db.query<{ permissions: string | null }>(`SELECT permissions FROM users WHERE username = 'secdoctora'`);
  const permissions = { ...(JSON.parse(user.permissions ?? "{}") as Record<string, unknown>), canViewPatientPayments: on };
  await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [JSON.stringify(permissions)]);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const insert = async (suffix: string, name: string, primary: number | null) => (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`FAMH-${suffix}-${stamp}`, name, primary])).rows[0].id;
  ownedId = await insert("A", "أب العائلة", doctor.party_id);
  otherId = await insert("B", "ابن العائلة", null);
  loneId = await insert("C", "مريض وحيد", null);
  for (const [patientId, minor, number] of [[ownedId, 40_000, "A"], [otherId, 15_000, "B"]] as const) {
    await db.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ($1, $2, $3, 0, 'YER', 't')`, [`INV-FAMH-${number}-${stamp}`, patientId, minor]);
  }
}, 120_000);

afterAll(async () => {
  await setDoctorPayments(false).catch(() => undefined);
  await db?.end();
});

describe("PAT-4 — who writes", () => {
  it("reception creates a family with members and a guarantor (audited)", async () => {
    const response = await post("reception", "/api/families", {
      name: "عائلة الاختبار", guarantor: { kind: "patient", patientId: ownedId },
      members: [{ patientId: ownedId, role: "father" }, { patientId: otherId, role: "son" }],
    });
    expect(response.status).toBe(201);
    const family = await response.json() as FamilyViewBody;
    familyId = family.id;
    expect(family.members.map((m) => m.id).sort()).toEqual([ownedId, otherId].sort());
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action LIKE 'family.%'
          AND ((entity = 'family' AND entity_id = $1) OR (entity = 'patient' AND entity_id = ANY($2::text[])))
        ORDER BY id`, [String(familyId), [String(ownedId), String(otherId)]]);
    expect(rows.map((r) => r.action)).toEqual(["family.create", "family.link", "family.link"]);
  });

  it("a doctor cannot write anything on families (Arabic 403)", async () => {
    await expectArabicOnly(await post("doctorA", "/api/families", { name: "عائلة طبيب", members: [] }), 403);
    await expectArabicOnly(await post("doctorA", `/api/families/${familyId}/members`, { patientId: loneId }), 403);
    await expectArabicOnly(await authedMutation(`/api/families/${familyId}/guarantor`, h.sessions.doctorA, "PUT", JSON.stringify({ guarantor: { kind: "none" } })), 403);
    await expectArabicOnly(await authedMutation(`/api/families/${familyId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ name: "x" })), 403);
    await expectArabicOnly(await authedMutation(`/api/families/${familyId}/members/${ownedId}`, h.sessions.doctorA, "DELETE"), 403);
  });

  it("cashier and accountant cannot reach family APIs or any clinical write", async () => {
    for (const who of ["cashier", "accountant"] as const) {
      await expectArabicOnly(await post(who, "/api/families", { name: "عائلة", members: [] }), 403);
      await expectArabicOnly(await post(who, `/api/families/${familyId}/members`, { patientId: loneId }), 403);
      await expectArabicOnly(await authedGet(`/api/patients/${ownedId}/family`, h.sessions[who]), 403);
      await expectArabicOnly(await authedGet(`/api/families/${familyId}`, h.sessions[who]), 403);
      await expectArabicOnly(await post(who, `/api/patients/${ownedId}/cases`, { specialty: "endodontics", title: "عصب" }), 403);
    }
  });

  it("reception links, re-roles, sets an outside guarantor, renames and unlinks", async () => {
    expect((await post("reception", `/api/families/${familyId}/members`, { patientId: loneId, role: "daughter" })).status).toBe(200);
    expect((await post("reception", `/api/families/${familyId}/members`, { patientId: loneId, role: "other" })).status).toBe(200);
    expect((await authedMutation(`/api/families/${familyId}/guarantor`, h.sessions.reception, "PUT",
      JSON.stringify({ guarantor: { kind: "external", name: "العم خالد", phone: "773000111" } }))).status).toBe(200);
    expect((await authedMutation(`/api/families/${familyId}`, h.sessions.reception, "PATCH", JSON.stringify({ name: "آل الاختبار" }))).status).toBe(200);
    expect((await authedMutation(`/api/families/${familyId}/members/${loneId}`, h.sessions.reception, "DELETE")).status).toBe(200);
  });
});

describe("PAT-4 — who sees members and balances", () => {
  it("reception sees every member with per-currency balances and a per-currency total", async () => {
    const response = await authedGet(`/api/patients/${ownedId}/family`, h.sessions.reception);
    expect(response.status).toBe(200);
    const { family } = await response.json() as { family: FamilyViewBody };
    expect(family.canSeeMoney).toBe(true);
    expect(family.members.map((m) => m.id).sort()).toEqual([ownedId, otherId].sort());
    expect(family.members.find((m) => m.id === ownedId)?.balances).toEqual([{ currency: "YER", balanceMinor: 40_000 }]);
    expect(family.totals).toEqual([{ currency: "YER", balanceMinor: 55_000 }]);
  });

  it("a doctor without canViewPatientPayments sees only his own patients among the members, and no money", async () => {
    await setDoctorPayments(false);
    const response = await authedGet(`/api/patients/${ownedId}/family`, h.sessions.doctorA);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const { family } = JSON.parse(raw) as { family: FamilyViewBody };
    expect(family.members.map((m) => m.id)).toEqual([ownedId]);
    expect(family.members[0].balances).toBeUndefined();
    expect(family.canSeeMoney).toBe(false);
    expect(family.totals).toBeUndefined();
    expect(family.canEdit).toBe(false);
    expect(raw).not.toContain("40000");
    expect(raw).not.toContain("ابن العائلة");
    await expectArabicOnly(await authedGet(`/api/patients/${otherId}/family`, h.sessions.doctorA), 403);
    expect((await authedGet(`/print/family-statement/${familyId}`, h.sessions.doctorA)).status).toBe(404);
  });

  it("the same doctor with canViewPatientPayments sees balances — still only for his own patients", async () => {
    await setDoctorPayments(true);
    try {
      const { family } = await (await authedGet(`/api/patients/${ownedId}/family`, h.sessions.doctorA)).json() as { family: FamilyViewBody };
      expect(family.members.map((m) => m.id)).toEqual([ownedId]);
      expect(family.members[0].balances).toEqual([{ currency: "YER", balanceMinor: 40_000 }]);
      expect(family.totals).toEqual([{ currency: "YER", balanceMinor: 40_000 }]);
      expect((await authedGet(`/print/family-statement/${familyId}`, h.sessions.doctorA)).status).toBe(200);
    } finally {
      await setDoctorPayments(false);
    }
  });

  it("a doctor who opens no member cannot read the family", async () => {
    await expectArabicOnly(await authedGet(`/api/families/${familyId}`, h.sessions.doctorB), 403);
  });

  it("cashier and accountant print the family statement (money viewers)", async () => {
    for (const who of ["cashier", "accountant", "reception", "admin"] as const) {
      const response = await authedGet(`/print/family-statement/${familyId}`, h.sessions[who]);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("كشف حساب العائلة");
    }
  });
});

describe("PAT-4 — Arabic-only errors", () => {
  it("400 / 404 / 409 carry only an Arabic message", async () => {
    await expectArabicOnly(await post("reception", "/api/families", { name: "   " }), 400);
    await expectArabicOnly(await post("reception", "/api/families", { name: "عائلة", members: [{ patientId: 1, role: "boss" }] }), 400);
    await expectArabicOnly(await post("reception", "/api/families/abc/members", { patientId: ownedId }), 400);
    await expectArabicOnly(await post("reception", "/api/families/99999999/members", { patientId: ownedId }), 404);
    await expectArabicOnly(await post("reception", `/api/families/${familyId}/members`, { patientId: 99_999_999 }), 404);
    await expectArabicOnly(await authedMutation(`/api/families/${familyId}/members/${loneId}`, h.sessions.reception, "DELETE"), 404);
    await expectArabicOnly(await authedGet("/api/families/99999999", h.sessions.reception), 404);
    const second = await post("reception", "/api/families", { name: "عائلة ثانية", members: [] });
    expect(second.status).toBe(201);
    const secondId = (await second.json() as { id: number }).id;
    await expectArabicOnly(await post("reception", `/api/families/${secondId}/members`, { patientId: ownedId }), 409);
    await expectArabicOnly(await post("reception", "/api/families", { name: "عائلة", members: [{ patientId: otherId }] }), 409);
  });

  it("no money row was created by any family write", async () => {
    const { rows: [counts] } = await db.query<{ payments: string; invoices: string }>(
      `SELECT (SELECT count(*) FROM payments WHERE patient_id = ANY($1::int[]))::text AS payments,
              (SELECT count(*) FROM invoices WHERE patient_id = ANY($1::int[]))::text AS invoices`,
      [[ownedId, otherId, loneId]]);
    expect(counts).toEqual({ payments: "0", invoices: "2" });
  });
});
