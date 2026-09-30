import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (REF-1) الإحالة الداخلية على PostgreSQL 18 — رحلة «محمد أحمد»: د. عقلان (تقويم) يحيل علاج عصب ٢١
 * إلى د. محمد داخل المركز، والتقويم متوقف عليه؛ يقبل ويُحجز له موعد ويُنجز فتعود النتيجة إلى المحيل.
 * والإحالة الخارجية القائمة لا تتغيّر.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createInternalReferral, transitionInternalReferral,
  listMyReferrals, listPatientReferrals, createReferral, closeReferral, doctorOwnsPatient, createClinicalCase,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let patientId = 0;
let orthodontist = 0;
let endodontist = 0;
let orthoCaseId = 0;
let referralId = 0;
let appointmentId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const doctor = async (name: string) => (await q<{ id: number }>(
    `INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id`, [name]))[0].id;
  orthodontist = await doctor("د. عقلان");
  endodontist = await doctor("د. محمد");
  patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ('P-REF-1', 'محمد أحمد', $1) RETURNING id`, [orthodontist]))[0].id;
  const orthoCase = await createClinicalCase({
    patientId, specialty: "orthodontics", title: "تقويم ثابت", site: null, problem: null,
    responsiblePartyId: orthodontist, orthoCaseId: null, actor: "dr-aqlan",
  });
  if (!orthoCase.ok) throw new Error(orthoCase.reason);
  orthoCaseId = orthoCase.case.id!;
  appointmentId = (await q<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id) VALUES ($1, '2026-10-04', '10:00', $2) RETURNING id`,
    [patientId, endodontist]))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(REF-1) internal referral journey", () => {
  it("the receiving doctor does not own the patient before the referral, and does after it", async () => {
    await q(`UPDATE appointments SET doctor_id = NULL WHERE id = $1`, [appointmentId]);
    expect(await doctorOwnsPatient(endodontist, patientId)).toBe(false);
    const created = await createInternalReferral({
      patientId, doctorPartyId: orthodontist, toPartyId: endodontist, toSpecialty: "endodontics",
      reason: "علاج عصب ٢١ قبل تركيب الحاصرة", teeth: "21", urgency: "soon",
      caseId: null, blocksCaseId: orthoCaseId, planItemId: null, actor: "dr-aqlan", actorRole: "doctor",
    });
    if (!created.ok) throw new Error(created.reason);
    referralId = created.referral.id;
    expect(created.referral).toMatchObject({
      kind: "internal", workflowState: "requested", status: "sent", toPartyId: endodontist, toName: "د. محمد",
      doctorPartyId: orthodontist, blocksCaseId: orthoCaseId,
    });
    expect(await doctorOwnsPatient(endodontist, patientId)).toBe(true);
  });

  it("refuses self-referral, a non-doctor receiver and another patient's case", async () => {
    const [lab] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('lab', 'معمل') RETURNING id`);
    const draft = { patientId, doctorPartyId: orthodontist, toSpecialty: "endodontics" as const, reason: "عصب", teeth: null, urgency: "routine" as const, caseId: null, blocksCaseId: null, planItemId: null, actor: "x" };
    expect(await createInternalReferral({ ...draft, toPartyId: orthodontist })).toEqual({ ok: false, reason: "self" });
    expect(await createInternalReferral({ ...draft, toPartyId: lab.id })).toEqual({ ok: false, reason: "bad_receiver" });
    const [other] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-REF-2', 'آخر') RETURNING id`);
    expect(await createInternalReferral({ ...draft, patientId: other.id, toPartyId: endodontist, blocksCaseId: orthoCaseId }))
      .toEqual({ ok: false, reason: "bad_link" });
  });

  it("walks the lifecycle: accept → schedule (appointment linked) → complete → acknowledge; illegal steps refused", async () => {
    const step = (action: "accept" | "decline" | "schedule" | "complete" | "acknowledge" | "cancel", extra: Partial<{ note: string; appointmentId: number; procedurePerformed: string; followupRequired: boolean; mayReturn: boolean }> = {}) =>
      transitionInternalReferral({
        id: referralId, action, note: extra.note ?? null, appointmentId: extra.appointmentId ?? null,
        procedurePerformed: extra.procedurePerformed ?? null, followupRequired: extra.followupRequired ?? null,
        mayReturn: extra.mayReturn ?? null, actor: "dr-mohammed", actorRole: "doctor",
      });
    expect(await step("complete", { procedurePerformed: "x" })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await step("accept")).toMatchObject({ ok: true, referral: { workflowState: "accepted", status: "sent" } });

    const [other] = await q<{ id: number }>(`SELECT id FROM patients WHERE patient_number = 'P-REF-2'`);
    const [foreign] = await q<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time) VALUES ($1, '2026-10-04', '11:00') RETURNING id`, [other.id]);
    expect(await step("schedule", { appointmentId: foreign.id })).toEqual({ ok: false, reason: "bad_appointment" });
    expect(await step("schedule", { appointmentId })).toMatchObject({
      ok: true, referral: { workflowState: "scheduled", appointmentId, appointmentDate: "2026-10-04 10:00" },
    });
    expect(await q(`SELECT referral_id FROM appointments WHERE id = $1`, [appointmentId])).toEqual([{ referral_id: referralId }]);

    const mine = await listMyReferrals(endodontist);
    expect(mine.toMe.map((one) => [one.id, one.patientName])).toEqual([[referralId, "محمد أحمد"]]);

    const done = await step("complete", { procedurePerformed: "حشو قنوات ٢١", followupRequired: true, mayReturn: false, note: "جاهز للحاصرة" });
    expect(done).toMatchObject({
      ok: true,
      referral: { workflowState: "completed", status: "completed", procedurePerformed: "حشو قنوات ٢١", followupRequired: true, mayReturn: false, completedBy: "dr-mohammed", outcomeNote: "جاهز للحاصرة" },
    });
    expect((await listMyReferrals(orthodontist)).returnedToMe.map((one) => one.id)).toEqual([referralId]);
    expect(await step("acknowledge")).toMatchObject({ ok: true, referral: { workflowState: "returned_to_referrer", status: "completed" } });
    expect((await listMyReferrals(orthodontist)).returnedToMe).toEqual([]);
    expect(await step("cancel", { note: "متأخر" })).toEqual({ ok: false, reason: "invalid_transition" });

    const actions = await q<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'referral.%' ORDER BY id`);
    expect(actions.map((row) => row.action)).toEqual(["referral.create", "referral.accept", "referral.schedule", "referral.complete", "referral.return"]);
  });

  it("decline and cancel close the referral as cancelled with their reason", async () => {
    const created = await createInternalReferral({
      patientId, doctorPartyId: orthodontist, toPartyId: endodontist, toSpecialty: "endodontics", reason: "تقييم ٤٦",
      teeth: "46", urgency: "routine", caseId: null, blocksCaseId: null, planItemId: null, actor: "dr-aqlan",
    });
    if (!created.ok) throw new Error(created.reason);
    const declined = await transitionInternalReferral({
      id: created.referral.id, action: "decline", note: "خارج اختصاصي — يُحال لجراح", appointmentId: null,
      procedurePerformed: null, followupRequired: null, mayReturn: null, actor: "dr-mohammed",
    });
    expect(declined).toMatchObject({ ok: true, referral: { workflowState: "declined", status: "cancelled", outcomeNote: "خارج اختصاصي — يُحال لجراح" } });
    expect(declined.ok && declined.referral.closedAt).not.toBeNull();
  });

  it("the database refuses a workflow state that contradicts the legacy status", async () => {
    await expect(q(`UPDATE patient_referrals SET workflow_state = 'scheduled' WHERE id = $1`, [referralId])).rejects.toThrow();
    await expect(q(
      `INSERT INTO patient_referrals (patient_id, to_name, to_specialty, reason, created_by, kind) VALUES ($1, 'x', 'other', 'سبب', 'x', 'internal')`,
      [patientId])).rejects.toThrow();
  });

  it("external referrals are unchanged: closed by their outcome; internal ones cannot be closed that way", async () => {
    const external = await createReferral({
      patientId, toName: "د. سامي — جراحة", toSpecialty: "oral_surgery", reason: "قلع ٣٨", teeth: "38", urgency: "routine",
      doctorPartyId: orthodontist, actor: "dr-aqlan",
    });
    expect(external).toMatchObject({ kind: "external", workflowState: null, status: "sent" });
    expect(await closeReferral({ id: external!.id, status: "completed", note: "قُلع", actor: "reception" }))
      .toMatchObject({ ok: true, referral: { status: "completed" } });
    const open = await createInternalReferral({
      patientId, doctorPartyId: orthodontist, toPartyId: endodontist, toSpecialty: "endodontics", reason: "عصب ١١",
      teeth: "11", urgency: "routine", caseId: null, blocksCaseId: null, planItemId: null, actor: "dr-aqlan",
    });
    if (!open.ok) throw new Error(open.reason);
    expect(await closeReferral({ id: open.referral.id, status: "completed", note: null, actor: "reception" }))
      .toEqual({ ok: false, reason: "internal" });
    expect((await listPatientReferrals(patientId)).length).toBe(4);
  });
});
