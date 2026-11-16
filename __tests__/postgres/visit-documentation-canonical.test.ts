/** M2 slice 85: canonical visit documentation on real PostgreSQL, synthetic data only.
 * A clinician or the owner documents any day; another documenting account today's visits
 * only, notes only; a missing price is the server price; overrides by the approved map's
 * grants, audited in the same transaction; addendum on a signed visit (request key
 * replays); a currency change and a lab draft refuse (409), signing needs its grant (slice
 * 86); outside is 404. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-document-secret-85");
const db = await import("../../lib/db");
const doc = await import("../../lib/canonical-visit-documentation");

const ACCOUNTS = {
  owner: { username: "SYN-VD-OWNER", role: "admin" },
  doctor: { username: "SYN-VD-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.visits.document": true } },
  discounter: { username: "SYN-VD-DISC", role: "doctor", doctor: true, patientScope: "all", grants: { "clinical.visits.document": true, "finance.discounts.apply": true } },
  raiser: { username: "SYN-VD-RAISE", role: "doctor", doctor: true, patientScope: "all", grants: { "clinical.visits.document": true, "finance.price-increases.apply": true, "finance.invoices.view": true } },
  assistant: { username: "SYN-VD-ASST", role: "assistant", patientScope: "all", grants: { "clinical.visits.document": true } },
  front: { username: "SYN-VD-FRONT", role: "reception", patientScope: "all", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const ids = { mine: 0, other: 0, today: 0, old: 0, signed: 0, otherVisit: 0, priced: 0, unpriced: 0 };
const PRICE = 10000;
const lines = async (visitId: number) => (await q("SELECT service_id, unit_price_minor::int AS price, tooth_code FROM visit_procedures WHERE visit_id=$1 ORDER BY id", [visitId]));
const act = async (key: Key, visitId: number, body: Record<string, unknown>) => doc.commandCanonicalVisitDocument(await fx.session(key), String(visitId), body, fx.pool);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  await q("INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,NULL,$3) RETURNING id", [number, `SYN VD ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-VD-1", fx.parties.doctor!);
  ids.other = await patient("SYN-VD-2", null);
  ids.priced = (await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('SYN VD filling',$1,TRUE,TRUE,'restorative') RETURNING id", [PRICE]))[0].id;
  ids.unpriced = (await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('SYN VD custom',0,TRUE,FALSE,'restorative') RETURNING id"))[0].id;
  const visit = async (patientId: number, doctor: number | null, extra = "") =>
    (await q(`INSERT INTO visits (patient_name, patient_id, doctor_id${extra ? ", arrived_at" : ""}) VALUES ('SYN VD',$1,$2${extra ? `, ${extra}` : ""}) RETURNING id`, [patientId, doctor]))[0].id as number;
  ids.today = await visit(ids.mine, fx.parties.doctor!);
  ids.old = await visit(ids.mine, fx.parties.doctor!, "now() - interval '3 days'");
  ids.signed = await visit(ids.mine, fx.parties.doctor!);
  await q("UPDATE visits SET signed_at = now(), signed_by = 'SYN' WHERE id = $1", [ids.signed]);
  ids.otherVisit = await visit(ids.other, null);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("save", () => {
  it("a clinician saves notes and procedures; a missing price is the server price; the response carries no money", async () => {
    const result = await act("doctor", ids.today, {
      chiefComplaint: "ألم اصطناعي", diagnosis: "تسوس", doctorId: fx.parties.doctor!,
      procedures: [{ serviceId: ids.priced, toothCode: 16, quantity: 1, doctorId: fx.parties.doctor! }],
    });
    expect(result).toMatchObject({ id: ids.today, chiefComplaint: "ألم اصطناعي", diagnosis: "تسوس", procedures: [{ serviceId: ids.priced, toothCode: 16 }] });
    expect(JSON.stringify(result)).not.toMatch(/unitPriceMinor|totalMinor|10000/);
    expect(await lines(ids.today)).toEqual([{ service_id: ids.priced, price: PRICE, tooth_code: 16 }]);
  });

  it("a changed price needs the map's grant: discount within the ceiling, increase, unpriced manual price; each audited", async () => {
    const line = (price: number | null, reason: string | null = null, serviceId = ids.priced) => ({ procedures: [{ serviceId, toothCode: 16, unitPriceMinor: price, priceReason: reason, doctorId: fx.parties.doctor! }], doctorId: fx.parties.doctor! });
    expect(await refusal(act("doctor", ids.today, line(9500, "خصم اصطناعي")))).toMatchObject({ message: expect.stringContaining("صلاحية تطبيق الخصم") });
    expect(await refusal(act("discounter", ids.today, line(5000, "خصم كبير")))).toMatchObject({ message: expect.stringContaining("يتجاوز الحد") });
    expect(await refusal(act("discounter", ids.today, line(9500)))).toMatchObject({ message: expect.stringContaining("اكتب سبب الخصم") });
    await act("discounter", ids.today, line(9500, "خصم ضمن الحد"));
    expect((await lines(ids.today))[0].price).toBe(9500);
    expect(await refusal(act("discounter", ids.today, line(12000, "رفع")))).toMatchObject({ message: expect.stringContaining("زيادة السعر") });
    const raised = await act("raiser", ids.today, line(12000, "رفع اصطناعي"));
    expect(raised).toMatchObject({ procedures: [{ unitPriceMinor: 12000 }] }); // the raiser holds the invoice view
    expect(await refusal(act("doctor", ids.today, line(3000, "سعر يدوي", ids.unpriced)))).toMatchObject({ message: expect.stringContaining("غير مسعّرة") });
    await act("raiser", ids.today, line(3000, "سعر يدوي اصطناعي", ids.unpriced));
    expect(await lines(ids.today)).toEqual([{ service_id: ids.unpriced, price: 3000, tooth_code: 16 }]);
    expect((await q("SELECT actor, details->>'النوع' AS kind FROM audit_log WHERE action='visit.price_override' AND entity_id=$1::text ORDER BY id", [ids.today])))
      .toEqual([{ actor: "SYN-VD-DISC", kind: "خصم" }, { actor: "SYN-VD-RAISE", kind: "رفع فوق الدليل" }, { actor: "SYN-VD-RAISE", kind: "سعر يدوي لخدمة غير مسعّرة" }]);
  });

  it("an unchanged line keeps its saved (authorized) price; a new line takes the catalogue price", async () => {
    const doctor = fx.parties.doctor!;
    await act("discounter", ids.today, { doctorId: doctor, procedures: [{ serviceId: ids.priced, toothCode: 21, unitPriceMinor: 9200, priceReason: "خصم مُبقى", doctorId: doctor }] });
    await act("doctor", ids.today, { doctorId: doctor, procedures: [
      { serviceId: ids.priced, toothCode: 21, doctorId: doctor },
      { serviceId: ids.priced, toothCode: 22, doctorId: doctor },
    ] });
    expect(await lines(ids.today)).toEqual([
      { service_id: ids.priced, price: 9200, tooth_code: 21 },
      { service_id: ids.priced, price: PRICE, tooth_code: 22 },
    ]);
  });

  it("another documenting account: today's visits only, notes only, the doctor and procedures unchanged", async () => {
    const current = (await q("SELECT service_id, tooth_code, quantity, doctor_id, plan_item_id FROM visit_procedures WHERE visit_id=$1", [ids.today]))
      .map(row => ({ serviceId: row.service_id, toothCode: row.tooth_code, quantity: row.quantity, doctorId: row.doctor_id, planItemId: row.plan_item_id }));
    await act("assistant", ids.today, { nextPlan: "متابعة بعد أسبوع", doctorId: fx.parties.doctor!, procedures: current });
    expect((await q("SELECT next_plan FROM visits WHERE id=$1", [ids.today]))[0].next_plan).toBe("متابعة بعد أسبوع");
    expect(await refusal(act("assistant", ids.today, { doctorId: fx.parties.raiser! }))).toMatchObject({ code: "assistant_doctor_locked", status: 403 });
    expect(await refusal(act("assistant", ids.today, { doctorId: fx.parties.doctor!, procedures: [] }))).toMatchObject({ code: "assistant_procedures_locked", status: 403 });
    expect(await refusal(act("assistant", ids.today, { doctorId: fx.parties.doctor!, procedures: current.map(row => ({ ...row, unitPriceMinor: 1 })) }))).toMatchObject({ code: "assistant_procedures_locked" });
    // The role rule precedes validation: an older visit refuses whatever the body.
    expect(await refusal(act("assistant", ids.old, { action: "addendum" }))).toMatchObject({ code: "visit_today_only", status: 403 });
    await act("doctor", ids.old, { examination: "فحص سابق", doctorId: fx.parties.doctor! });
    expect((await q("SELECT examination FROM visits WHERE id=$1", [ids.old]))[0].examination).toBe("فحص سابق");
  });

  it("refused, never guessed: signing, a currency change, a lab draft; a signed visit; outside the scope; no grant", async () => {
    // Slice 86: signing is canonical; without clinical.visits.sign it is refused by its grant.
    expect(await refusal(act("doctor", ids.today, { action: "sign" }))).toMatchObject({ code: "visit_sign_not_granted", status: 403 });
    expect((await q("SELECT signed_at FROM visits WHERE id=$1", [ids.today]))[0].signed_at).toBeNull();
    expect(await refusal(act("doctor", ids.today, { billingCurrency: "USD" }))).toMatchObject({ code: "billing_currency_financial", status: 409 });
    // Slice 87: the lab draft is canonical; without clinical.lab.order it is refused by its grant.
    expect(await refusal(act("doctor", ids.today, { labRequestKey: "syn-lab-key-0001", procedures: [] }))).toMatchObject({ code: "lab_order_not_granted", status: 403 });
    expect(await refusal(act("doctor", ids.signed, { diagnosis: "تعديل", doctorId: fx.parties.doctor! }))).toMatchObject({ code: "visit_signed", status: 409 });
    expect(await refusal(act("doctor", ids.otherVisit, { diagnosis: "x" }))).toMatchObject({ code: "visit_not_found", status: 404 });
    expect(await refusal(act("front", ids.today, { diagnosis: "x" }))).toMatchObject({ message: expect.stringMatching(/CAPABILITY_DENIED$/) });
  });
});

describe("addendum", () => {
  it("appends to a signed visit, audited; a request key replays; an open visit refuses", async () => {
    const body = { action: "addendum", text: "ملحق اصطناعي", requestKey: "syn-addendum-key-0001" };
    await act("doctor", ids.signed, body);
    await act("doctor", ids.signed, body);
    expect((await q("SELECT addendum FROM visits WHERE id=$1", [ids.signed]))[0].addendum.match(/ملحق اصطناعي/g)).toHaveLength(1);
    expect((await q("SELECT actor FROM audit_log WHERE action='visit.addendum' AND entity_id=$1::text", [ids.signed])).map(row => row.actor)).toEqual(["SYN-VD-DR"]);
    expect(await refusal(act("doctor", ids.today, { action: "addendum", text: "ملحق" }))).toMatchObject({ code: "visit_not_signed", status: 409 });
    expect(await refusal(act("doctor", ids.signed, { action: "addendum", text: " " }))).toMatchObject({ code: "invalid_addendum", status: 400 });
  });
});
