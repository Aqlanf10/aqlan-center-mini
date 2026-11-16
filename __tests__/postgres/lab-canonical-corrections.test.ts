/** M2 slice 69: canonical lab-order corrections (PATCH /api/lab/[id] actions
 * complete_prescription, update_clinical, update_shade) on real PostgreSQL, synthetic data
 * only. One admitted clinical.visits.document transaction each, the legacy writers'
 * bodies through an injectable authority: observed-version / snapshot / specification
 * comparisons, the saved financial locks, the doctor binding, the patient scope and the
 * atomic audit rows; concurrent edits from one observed state apply once. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { labPrescriptionVersion } from "../../lib/lab-prescription-input";
import { labShadeSelectionForCode } from "../../lib/lab-shades";
import type { LabOrder } from "../../lib/lab";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-corrections-2026");
const db = await import("../../lib/db");
const fix = await import("../../lib/canonical-lab-corrections");

const ACCOUNTS = {
  owner: { username: "SYN-LX-OWNER", role: "admin" },
  documenter: { username: "SYN-LX-DOC", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.visits.document": true } },
  doctor: { username: "SYN-LX-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.lab.view": true, "clinical.visits.document": true } },
  orderOnly: { username: "SYN-LX-ORDER", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  noScope: { username: "SYN-LX-NOSCOPE", role: "reception", grants: { "clinical.lab.view": true, "clinical.visits.document": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ctx = { mine: 0, theirs: 0, lab: 0, lab2: 0, otherDoctor: 0 };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const shade = (code: string, tooth = 16) => ({ version: 1 as const, teeth: [{ toothCode: tooth, cervical: null, body: labShadeSelectionForCode(code), incisal: null }] });

async function order(input: { status?: string; patient?: "mine" | "theirs"; cost?: number | null; doctor?: number | null; party?: number | null } = {}): Promise<number> {
  const party = input.party === undefined ? ctx.lab : input.party;
  return (await q(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor,doctor_id,tooth_numbers,source)
    VALUES ($1,$2,$3,'تاج زيركون كامل',$4,'2031-01-01','2031-01-10',$5,$6,1,$5,$7,'16','manual') RETURNING id`,
  [ctx[input.patient ?? "theirs"], party, party === null ? "لم يُحدَّد بعد" : "SYN Lab Fix", input.status ?? "needed", input.cost ?? null, input.cost == null ? null : "YER", input.doctor === undefined ? ctx.otherDoctor : input.doctor]))[0].id as number;
}
const get = async (id: number) => (await db.getLabOrderById(id)) as LabOrder;
const snapshot = (o: LabOrder) => ({ doctorId: o.doctorId ?? null, workType: o.workType, toothNumbers: o.toothNumbers ?? null, shade: o.shade ?? null,
  shadeSpecification: o.shadeSpecification ?? null, partyId: o.partyId ?? null, labName: o.labName, labPhone: o.labPhone ?? null });
const prescription = (partyId: number | null, dueDate = "2031-01-20") => ({ partyId, shade: "A2", stumpShade: "", toothNumbers: "16(Crown)", dueDate, impressionType: "physical", priority: "normal" });
const audits = async (action: string, id: number) => (await q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, id])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000970',$3) RETURNING id", [number, `SYN Lab ${number}`, doctor]))[0].id as number;
  ctx.mine = await patient("SYN-LX-1", fx.parties.doctor!);
  ctx.theirs = await patient("SYN-LX-2", null);
  ctx.lab = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Lab Fix','lab','YER') RETURNING id"))[0].id;
  ctx.lab2 = (await q("INSERT INTO parties(name,kind,currency,phone) VALUES('SYN Lab Two','lab','YER','0500000971') RETURNING id"))[0].id;
  ctx.otherDoctor = (await q("INSERT INTO parties(name,kind,is_active) VALUES('SYN Fix Doctor','doctor',TRUE) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("complete_prescription", () => {
  it("saves a draft, then dispatches with the observed version; tracking and audit carry the admitted actor", async () => {
    const id = await order({ party: null });
    const documenter = await fx.session("documenter");
    expect(await fix.commandCanonicalLabPrescription(documenter, String(id), { expected: labPrescriptionVersion(await get(id)), dispatch: false, prescription: prescription(ctx.lab) }))
      .toEqual({ id, status: "needed" });
    expect(await fix.commandCanonicalLabPrescription(documenter, String(id), { expected: labPrescriptionVersion(await get(id)), dispatch: true, prescription: prescription(ctx.lab) }))
      .toEqual({ id, status: "sent" });
    expect(await get(id)).toMatchObject({ status: "sent", partyId: ctx.lab, shade: "A2", toothNumbers: "16(Crown)", dueDate: "2031-01-20" });
    expect((await q("SELECT action, actor FROM lab_order_tracking WHERE lab_order_id=$1 ORDER BY id", [id])).map(row => `${row.action}:${row.actor}`))
      .toEqual(["prescription_draft_saved:SYN-LX-DOC", "prescription_completed:SYN-LX-DOC"]);
    expect(await audits("lab_order.prescription_updated", id)).toEqual(["SYN-LX-DOC", "SYN-LX-DOC"]);
  });
  it("refuses a stale version, work already sent, and a lab change when a cost is attached — without writing", async () => {
    const documenter = await fx.session("documenter");
    const stale = await order();
    const version = labPrescriptionVersion(await get(stale));
    await q("UPDATE lab_orders SET priority='urgent' WHERE id=$1", [stale]);
    expect(await refusal(fix.commandCanonicalLabPrescription(documenter, String(stale), { expected: version, dispatch: true, prescription: prescription(ctx.lab) }))).toMatchObject({ status: 409 });
    const sent = await order({ status: "sent" });
    expect(await refusal(fix.commandCanonicalLabPrescription(documenter, String(sent), { expected: labPrescriptionVersion(await get(sent)), dispatch: true, prescription: prescription(ctx.lab) }))).toMatchObject({ status: 409 });
    const costed = await order({ cost: 30000 });
    expect(await refusal(fix.commandCanonicalLabPrescription(documenter, String(costed), { expected: labPrescriptionVersion(await get(costed)), dispatch: true, prescription: prescription(ctx.lab2) }))).toMatchObject({ status: 409 });
    expect([(await get(stale)).status, (await get(costed)).partyId]).toEqual(["needed", ctx.lab]);
    expect(await refusal(fix.commandCanonicalLabPrescription(documenter, String(stale), { expected: version, dispatch: true, prescription: { ...prescription(ctx.lab), shade: "Z9" } }))).toMatchObject({ code: "invalid_lab_correction", status: 400 });
  });
});

describe("update_clinical", () => {
  it("corrects the work from the observed snapshot; a stale snapshot is a conflict", async () => {
    const id = await order({ status: "sent" });
    const documenter = await fx.session("documenter");
    const before = snapshot(await get(id));
    const next = { ...before, workType: "تاج إيماكس", toothNumbers: "17" };
    expect(await fix.commandCanonicalLabClinical(documenter, String(id), { clinical: next, expectedClinical: before })).toEqual({ ok: true });
    expect(await get(id)).toMatchObject({ workType: "تاج إيماكس", toothNumbers: "17" });
    expect(await audits("lab_order.clinical", id)).toEqual(["SYN-LX-DOC"]);
    expect(await refusal(fix.commandCanonicalLabClinical(documenter, String(id), { clinical: { ...before, toothNumbers: "15" }, expectedClinical: before }))).toMatchObject({ code: "lab_clinical_conflict", status: 409 });
  });
  it("keeps the saved financial links: no doctor or lab change once money is attached", async () => {
    const id = await order({ status: "sent", cost: 30000 });
    const documenter = await fx.session("documenter");
    const before = snapshot(await get(id));
    expect(await refusal(fix.commandCanonicalLabClinical(documenter, String(id), { clinical: { ...before, doctorId: fx.parties.doctor }, expectedClinical: before }))).toMatchObject({ code: "financial_doctor_locked" });
    expect(await refusal(fix.commandCanonicalLabClinical(documenter, String(id), { clinical: { ...before, partyId: ctx.lab2, labName: "SYN Lab Two", labPhone: "0500000971" }, expectedClinical: before }))).toMatchObject({ code: "financial_lab_locked" });
    expect(snapshot(await get(id))).toEqual(before);
  });
  it("a clinician reassigns the treating doctor only to itself; another patient's order reads as missing", async () => {
    const doctor = await fx.session("doctor");
    const mine = await order({ status: "sent", patient: "mine", doctor: null });
    const before = snapshot(await get(mine));
    expect(await refusal(fix.commandCanonicalLabClinical(doctor, String(mine), { clinical: { ...before, doctorId: ctx.otherDoctor }, expectedClinical: before })))
      .toMatchObject({ code: "lab_doctor_forbidden", status: 403 });
    expect(await fix.commandCanonicalLabClinical(doctor, String(mine), { clinical: { ...before, doctorId: fx.parties.doctor }, expectedClinical: before })).toEqual({ ok: true });
    expect((await get(mine)).doctorId).toBe(fx.parties.doctor);
    const theirs = await order({ status: "sent" });
    const theirsBefore = snapshot(await get(theirs));
    expect(await refusal(fix.commandCanonicalLabClinical(doctor, String(theirs), { clinical: { ...theirsBefore, toothNumbers: "15" }, expectedClinical: theirsBefore }))).toMatchObject({ code: "lab_order_not_found", status: 404 });
  });
});

describe("update_shade", () => {
  it("edits from the observed specification; two concurrent edits from one state apply once", async () => {
    const id = await order({ status: "sent" });
    const documenter = await fx.session("documenter");
    expect(await fix.commandCanonicalLabShade(documenter, String(id), { shadeSpecification: shade("A2"), expectedShadeSpecification: null })).toMatchObject({ ok: true });
    const results = await Promise.allSettled([
      fix.commandCanonicalLabShade(documenter, String(id), { shadeSpecification: shade("A3"), expectedShadeSpecification: shade("A2") }),
      fix.commandCanonicalLabShade(await fx.session("owner"), String(id), { shadeSpecification: shade("B1"), expectedShadeSpecification: shade("A2") }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason.code)).toEqual(["lab_shade_conflict"]);
    expect((await audits("lab_order.shade", id)).length).toBe(2);
    expect(await refusal(fix.commandCanonicalLabShade(documenter, String(id), { shadeSpecification: shade("A2", 21), expectedShadeSpecification: (await get(id)).shadeSpecification ?? null }))).toMatchObject({ code: "invalid_lab_correction" });
  });
});

describe("authority", () => {
  it("needs clinical.visits.document and a patient scope", async () => {
    const id = await order({ status: "sent" });
    const before = snapshot(await get(id));
    await expect(fix.commandCanonicalLabClinical(await fx.session("orderOnly"), String(id), { clinical: { ...before, toothNumbers: "15" }, expectedClinical: before })).rejects.toThrow("CAPABILITY_DENIED");
    await expect(fix.commandCanonicalLabShade(await fx.session("noScope"), String(id), { shadeSpecification: shade("A2"), expectedShadeSpecification: null })).rejects.toThrow("RECORD_SCOPE_DENIED");
    await expect(fix.commandCanonicalLabPrescription(await fx.session("orderOnly"), String(id), { expected: "x", dispatch: false, prescription: prescription(ctx.lab) })).rejects.toThrow("CAPABILITY_DENIED");
    expect(snapshot(await get(id))).toEqual(before);
  });
});
