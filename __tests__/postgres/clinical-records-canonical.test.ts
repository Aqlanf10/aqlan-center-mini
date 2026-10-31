/** Slice 34: Canonical Documents, Photo, Prescriptions, Referrals, Dental Chart & Clinical Writes on real PostgreSQL 18. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-clinical-records-canonical-20261031");

const tempDocsDir = mkdtempSync(join(tmpdir(), "aqlan-slice34-docs-"));
vi.stubEnv("DOCUMENTS_DIR", tempDocsDir);

const db = await import("../../lib/db");
const clinical = await import("../../lib/canonical-clinical-records");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");

// Minimal valid 1x1 PNG bytes (magic header 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const ACCOUNTS = {
  ownerDoctor: {
    username: "SYN-CLIN-OWNER",
    role: "admin",
    doctor: true,
  },
  ownDoctor: {
    username: "SYN-CLIN-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.xrays.view": true,
      "clinical.xrays.upload": true,
      "clinical.prescriptions.write": true,
      "clinical.referrals.manage": true,
      "clinical.visits.document": true,
      "patients.edit": true,
    },
  },
  otherDoctor: {
    username: "SYN-CLIN-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.xrays.view": true,
      "clinical.prescriptions.write": true,
      "clinical.referrals.manage": true,
      "clinical.visits.document": true,
    },
  },
  docDeleter: {
    username: "SYN-CLIN-DOC-DEL",
    role: "admin",
    patientScope: "all",
    grants: {
      "clinical.xrays.view": true,
      "patients.documents.delete": true,
    },
  },
  receptionOperational: {
    username: "SYN-CLIN-RECEP",
    role: "reception",
    patientScope: "all",
    grants: {
      "patients.operational-summary.view": true,
      "patients.edit": true,
    },
  },
  unlinkedPrescriber: {
    username: "SYN-CLIN-UNLINKED-RX",
    role: "admin",
    patientScope: "all",
    grants: {
      "clinical.prescriptions.write": true,
    },
  },
  noneScopeDoctor: {
    username: "SYN-CLIN-DOC-NONE",
    role: "doctor",
    doctor: true,
    patientScope: "none",
    grants: {
      "clinical.xrays.view": true,
      "clinical.visits.document": true,
    },
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;

const ids = {
  ownPatient: 0,
  foreignPatient: 0,
  ownVisit: 0,
  planId: 0,
  planItemId: 0,
};

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "ownerDoctor");

  ids.ownPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-CL34-P1','SYN Clinical Own','777100200',$1) RETURNING id",
      [fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.foreignPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-CL34-P2','SYN Clinical Foreign','777100201',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  ids.ownVisit = (
    await fx.pool.query<{ id: number }>(
      `INSERT INTO visits(patient_id,patient_name,status,doctor_id)
       VALUES($1,'SYN Clinical Own','in_chair',$2) RETURNING id`,
      [ids.ownPatient, fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.planId = (
    await fx.pool.query<{ id: number }>(
      `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,total_from_items,primary_doctor_id,created_by)
       VALUES($1,'SYN Plan 34','active','YER',15000,TRUE,$2,'SYN-CLIN-OWNER') RETURNING id`,
      [ids.ownPatient, fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.planItemId = (
    await fx.pool.query<{ id: number }>(
      `INSERT INTO plan_items(plan_id,service_name,category,tooth_code,surfaces,session_count,unit_price_minor,quantity,status,sort_order)
       VALUES($1,'حشوة تجميلية سن 16','filling',16,'MO',1,15000,1,'planned',1) RETURNING id`,
      [ids.planId],
    )
  ).rows[0].id;
}, 120_000);

afterAll(async () => {
  await fx?.close();
  try {
    rmSync(tempDocsDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error on Windows file handles
  }
});

it("registers read:patients.documents, read:patients.prescriptions, and read:patients.prescriptions-saved", () => {
  expect(CANONICAL_RECORD_READS["read:patients.documents"]).toEqual({
    record: "patient",
    need: ["clinical.xrays.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:patients.prescriptions"]).toEqual({
    record: "patient",
    need: ["clinical.prescriptions.write"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:patients.prescriptions-saved"]).toEqual({
    record: "patient",
    need: [],
    anyOf: ["clinical.prescriptions.write", "patients.operational-summary.view"],
  });
});

it("governs document upload, magic-bytes rejection audit, photo selection, soft-delete projection, and scope isolation", async () => {
  // 1. Foreign patient returns 404 for own-scope doctor
  await expect(
    clinical.readCanonicalPatientDocuments(await fx.session("ownDoctor"), ids.foreignPatient),
  ).rejects.toMatchObject({ code: "patient_not_found" });

  // 2. Spoofed PNG magic-bytes rejected and audited inside transaction
  const badForm = new FormData();
  badForm.set("file", new File([Buffer.from("not-a-real-png")], "spoof.png", { type: "image/png" }));
  badForm.set("kind", "photo");
  badForm.set("title", "صورة مزيفة");

  const rejected = await clinical.commandCanonicalDocumentUpload(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    badForm,
    fx.pool,
  );
  expect(rejected.kind).toBe("rejected_signature");

  const spoofAudits = await fx.pool.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE action = 'document.upload.rejected_signature' AND entity_id = $1",
    [String(ids.ownPatient)],
  );
  expect(spoofAudits.rowCount).toBe(1);

  // 3. Valid PNG upload succeeds with dimensions + atomic audit
  const okForm = new FormData();
  okForm.set("file", new File([VALID_PNG_BYTES], "profile.png", { type: "image/png" }));
  okForm.set("kind", "photo");
  okForm.set("title", "صورة شخصية للملف");
  okForm.set("visitId", String(ids.ownVisit));

  const uploaded = await clinical.commandCanonicalDocumentUpload(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    okForm,
    fx.pool,
  );
  expect(uploaded.kind).toBe("uploaded");
  if (uploaded.kind !== "uploaded") throw new Error("expected uploaded");
  expect(uploaded.document.width).toBe(1);
  expect(uploaded.document.height).toBe(1);

  // 4. Download inline succeeds for viewer in scope; refused for reception without clinical.xrays.view
  const inlineRes = await clinical.readCanonicalDocumentDownload(
    await fx.session("ownDoctor"),
    String(uploaded.document.id),
    false,
  );
  expect(inlineRes.status).toBe(200);
  expect(inlineRes.headers.get("Content-Disposition")).toContain("inline;");

  await expect(
    clinical.readCanonicalDocumentDownload(
      await fx.session("receptionOperational"),
      String(uploaded.document.id),
      false,
    ),
  ).rejects.toThrow();

  // 5. Select uploaded PNG as patient profile photo (reception has patients.edit + operational summary, no care leak)
  const photoRes = await clinical.commandCanonicalPatientPhoto(
    await fx.session("receptionOperational"),
    String(ids.ownPatient),
    { documentId: uploaded.document.id },
    fx.pool,
  );
  expect(photoRes.photoDocumentId).toBe(uploaded.document.id);
  expect("medicalAlert" in photoRes).toBe(false);

  // 6. Soft-delete without patients.documents.delete is refused; docDeleter soft-deletes and clears photo_document_id
  await expect(
    clinical.commandCanonicalDocumentDelete(
      await fx.session("ownDoctor"),
      String(uploaded.document.id),
      { note: "محاولة بدون صلاحية" },
      fx.pool,
    ),
  ).rejects.toThrow();

  const deleted = await clinical.commandCanonicalDocumentDelete(
    await fx.session("docDeleter"),
    String(uploaded.document.id),
    { note: "رفع تجريبي بالخطأ" },
    fx.pool,
  );
  expect(deleted).toEqual({ ok: true });

  const patientPhotoCheck = await fx.pool.query<{ photo_document_id: number | null }>(
    "SELECT photo_document_id FROM patients WHERE id = $1",
    [ids.ownPatient],
  );
  expect(patientPhotoCheck.rows[0].photo_document_id).toBeNull();

  // 7. Projection: ownDoctor (xrays.view only) does NOT see removed document or download it; docDeleter DOES see & download it
  const ownDocs = await clinical.readCanonicalPatientDocuments(await fx.session("ownDoctor"), ids.ownPatient);
  expect(ownDocs.documents.find(d => d.id === uploaded.document.id)).toBeUndefined();

  await expect(
    clinical.readCanonicalDocumentDownload(await fx.session("ownDoctor"), String(uploaded.document.id), true),
  ).rejects.toMatchObject({ status: 404, code: "document_removed" });

  const deleterDocs = await clinical.readCanonicalPatientDocuments(await fx.session("docDeleter"), ids.ownPatient);
  expect(deleterDocs.documents.find(d => d.id === uploaded.document.id)?.removedAt).toBeTruthy();

  const deleterDownload = await clinical.readCanonicalDocumentDownload(
    await fx.session("docDeleter"),
    String(uploaded.document.id),
    true,
  );
  expect(deleterDownload.status).toBe(200);
  expect(deleterDownload.headers.get("Content-Disposition")).toContain("attachment;");
});

it("enforces prescription clinician binding, owner other-doctor authority, allergy blocks, HMAC warning ack, idempotency, and issuer-only voiding", async () => {
  // Seed structured medical history with bleeding_disorder + severe penicillin allergy via canonical medical-history write
  const medHistory = await clinical.commandCanonicalMedicalHistoryCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    {
      answers: { bleeding_disorder: "yes" },
      allergies: [{ substance: "Penicillin", reaction: "Anaphylaxis", severity: "severe" }],
      medications: [{ name: "Aspirin", dose: "81mg" }],
      asaClass: "II",
      bloodGroup: "O+",
      patientConfirmed: true,
    },
    fx.pool,
  );
  expect(medHistory.asaClass).toBe("II");

  // 1. prescriberOptions projection: ownDoctor gets only self; ownerDoctor gets canChooseAnyDoctor = true
  const ownRxView = await clinical.readCanonicalPatientPrescriptions(await fx.session("ownDoctor"), ids.ownPatient);
  expect(ownRxView.prescriberOptions.canChooseAnyDoctor).toBe(false);
  expect(ownRxView.prescriberOptions.doctors).toHaveLength(1);

  const ownerRxView = await clinical.readCanonicalPatientPrescriptions(await fx.session("ownerDoctor"), ids.ownPatient);
  expect(ownerRxView.prescriberOptions.canChooseAnyDoctor).toBe(true);
  expect(ownerRxView.prescriberOptions.doctors.length).toBeGreaterThanOrEqual(2);

  const rxItem = (name: string, dose: string, frequency: string, duration: string) => ({
    name,
    dose,
    form: "Tablets",
    frequency,
    duration,
    selection: { id: "manual", amount: "1 box", confirmed: true },
  });

  // 2. Unlinked prescriber refused with 403 clinician_link_required
  const unlinkedRes = await clinical.commandCanonicalPrescriptionCreate(
    new Request("http://localhost/api/prescriptions", { method: "POST" }),
    await fx.session("unlinkedPrescriber"),
    {
      patientId: ids.ownPatient,
      items: [rxItem("Paracetamol", "500mg", "عند اللزوم", "3 أيام")],
    },
    fx.pool,
  );
  expect(unlinkedRes.status).toBe(403);
  expect((await unlinkedRes.json()).code).toBe("clinician_link_required");

  // 3. Delegated doctor refused when selecting another doctor's partyId
  const otherDocForbidden = await clinical.commandCanonicalPrescriptionCreate(
    new Request("http://localhost/api/prescriptions", { method: "POST" }),
    await fx.session("ownDoctor"),
    {
      patientId: ids.ownPatient,
      prescribingDoctorPartyId: fx.parties.otherDoctor!,
      items: [rxItem("Paracetamol", "500mg", "عند اللزوم", "3 أيام")],
    },
    fx.pool,
  );
  expect(otherDocForbidden.status).toBe(403);
  expect((await otherDocForbidden.json()).code).toBe("other_doctor_forbidden");

  // 4. Critical penicillin allergy blocks Amoxicillin with 409
  const criticalRes = await clinical.commandCanonicalPrescriptionCreate(
    new Request("http://localhost/api/prescriptions", { method: "POST" }),
    await fx.session("ownDoctor"),
    {
      patientId: ids.ownPatient,
      items: [rxItem("Amoxicillin", "500mg", "كل 8 ساعات", "5 أيام")],
    },
    fx.pool,
  );
  expect(criticalRes.status).toBe(409);
  expect((await criticalRes.json()).blockReason).toBe("critical_medication_safety");

  // 5. Non-critical bleeding_disorder + Ibuprofen returns 200 preview with HMAC token, then 201 on ack + Idempotency replay
  const warningBody = {
    patientId: ids.ownPatient,
    visitId: ids.ownVisit,
    diagnosis: "ألم بعد التحضير",
    items: [rxItem("Ibuprofen", "400mg", "بعد الأكل", "3 أيام")],
  };
  const previewRes = await clinical.commandCanonicalPrescriptionCreate(
    new Request("http://localhost/api/prescriptions", { method: "POST" }),
    await fx.session("ownDoctor"),
    warningBody,
    fx.pool,
  );
  expect(previewRes.status).toBe(200);
  const previewJson = await previewRes.json();
  expect(previewJson.requiresAcknowledgement).toBe(true);
  expect(typeof previewJson.acknowledgementToken).toBe("string");

  const ackBody = { ...warningBody, acknowledgedSafetyToken: previewJson.acknowledgementToken };
  const saveReq1 = new Request("http://localhost/api/prescriptions", {
    method: "POST",
    headers: { "Idempotency-Key": "syn-rx-idem-001" },
  });
  const savedRes1 = await clinical.commandCanonicalPrescriptionCreate(
    saveReq1,
    await fx.session("ownDoctor"),
    ackBody,
    fx.pool,
  );
  expect(savedRes1.status).toBe(201);
  const savedJson1 = await savedRes1.json();
  expect(savedJson1.acknowledged).toBe(true);

  const saveReq2 = new Request("http://localhost/api/prescriptions", {
    method: "POST",
    headers: { "Idempotency-Key": "syn-rx-idem-001" },
  });
  const savedRes2 = await clinical.commandCanonicalPrescriptionCreate(
    saveReq2,
    await fx.session("ownDoctor"),
    ackBody,
    fx.pool,
  );
  expect(savedRes2.status).toBe(201);
  expect((await savedRes2.json()).id).toBe(savedJson1.id);

  // 6. Owner doctor can issue a prescription selecting otherDoctor; reception can read saved prints picker
  const ownerForOtherRes = await clinical.commandCanonicalPrescriptionCreate(
    new Request("http://localhost/api/prescriptions", { method: "POST" }),
    await fx.session("ownerDoctor"),
    {
      patientId: ids.ownPatient,
      prescribingDoctorPartyId: fx.parties.otherDoctor!,
      items: [rxItem("Paracetamol", "500mg", "كل 6 ساعات", "3 أيام")],
    },
    fx.pool,
  );
  expect(ownerForOtherRes.status).toBe(201);

  const savedPrints = await clinical.readCanonicalSavedPrescriptionPrints(
    await fx.session("receptionOperational"),
    String(ids.ownPatient),
    null,
    null,
  );
  expect(savedPrints.prescriptions.length).toBeGreaterThanOrEqual(2);

  // 7. Voiding: ownerDoctor (not the issuer of savedJson1.id) is refused with 403 void_not_issuer; ownDoctor voids it
  await expect(
    clinical.commandCanonicalPrescriptionVoid(
      await fx.session("ownerDoctor"),
      String(savedJson1.id),
      { reason: "محاولة إبطال وصفة زميل" },
      fx.pool,
    ),
  ).rejects.toMatchObject({ status: 403, code: "void_not_issuer" });

  const voided = await clinical.commandCanonicalPrescriptionVoid(
    await fx.session("ownDoctor"),
    String(savedJson1.id),
    { reason: "تعديل الجرعة بطلب الطبيب المُصدر" },
    fx.pool,
  );
  expect(voided).toEqual({ ok: true });
});

it("governs external and internal referrals across sender, receiver, patient scope, and personal worklists", async () => {
  // 1. External referral create + close
  const extRef = await clinical.commandCanonicalReferralCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    {
      toName: "د. سامي الجراح",
      toSpecialty: "oral_surgery",
      reason: "قلع ضرس العقل المنطمر 38",
      teeth: "38",
      urgency: "soon",
    },
    fx.pool,
  );
  expect(extRef.kind).toBe("external");
  expect(extRef.status).toBe("sent");

  const closedExt = await clinical.commandCanonicalReferralClose(
    await fx.session("ownDoctor"),
    String(extRef.id),
    { action: "complete", note: "تم القلع الجراحي بنجاح" },
    fx.pool,
  );
  expect(closedExt.status).toBe("completed");

  // 2. Internal referral from ownDoctor -> otherDoctor brings patient into otherDoctor's own scope!
  const intRef = await clinical.commandCanonicalReferralCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    {
      kind: "internal",
      toPartyId: fx.parties.otherDoctor!,
      toSpecialty: "endodontics",
      reason: "تقييم وعلاج عصب للسن 16",
      teeth: "16",
      urgency: "urgent",
    },
    fx.pool,
  );
  expect(intRef.kind).toBe("internal");
  expect(intRef.workflowState).toBe("requested");

  // Personal worklist for receiving doctor shows incoming referral
  const otherWork = await clinical.readCanonicalMyReferrals(await fx.session("otherDoctor"));
  expect(otherWork.toMe.some(r => r.id === intRef.id)).toBe(true);

  // Referrer cannot accept on behalf of receiver
  await expect(
    clinical.commandCanonicalReferralTransition(
      await fx.session("ownDoctor"),
      String(intRef.id),
      { action: "accept" },
      fx.pool,
    ),
  ).rejects.toMatchObject({ status: 403, code: "referral_actor_forbidden" });

  // Receiver accepts and completes
  const accepted = await clinical.commandCanonicalReferralTransition(
    await fx.session("otherDoctor"),
    String(intRef.id),
    { action: "accept", note: "تم القبول للمعاينة" },
    fx.pool,
  );
  expect(accepted.workflowState).toBe("accepted");

  const completed = await clinical.commandCanonicalReferralTransition(
    await fx.session("otherDoctor"),
    String(intRef.id),
    {
      action: "complete",
      procedurePerformed: "حشو أقنية جذور كامل للسن 16",
      followupRequired: false,
      mayReturn: true,
    },
    fx.pool,
  );
  expect(completed.workflowState).toBe("completed");

  // Referrer sees returned referral and acknowledges it
  const referrerWork = await clinical.readCanonicalMyReferrals(await fx.session("ownDoctor"));
  expect(referrerWork.returnedToMe.some(r => r.id === intRef.id)).toBe(true);

  const acknowledged = await clinical.commandCanonicalReferralTransition(
    await fx.session("ownDoctor"),
    String(intRef.id),
    { action: "acknowledge", note: "تم الاطلاع واستئناف الخطة" },
    fx.pool,
  );
  expect(acknowledged.workflowState).toBe("returned_to_referrer");
});

it("governs dental chart (auto-completing single-session plan_items), clinical-context plan gating, diagnoses, problems, vitals, and intake", async () => {
  // 1. Dental chart record with stage = completed auto-completes matching single-session plan_item on tooth 16
  const toothRec = await clinical.commandCanonicalToothCondition(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    {
      toothCode: 16,
      condition: "filling",
      stage: "completed",
      surfaces: "MO",
      visitId: ids.ownVisit,
      note: "حشوة كومبوزيت تجميلية",
    },
    fx.pool,
  );
  expect(toothRec.toothCode).toBe(16);

  const itemAfterChart = await fx.pool.query<{ status: string; visit_id: number | null }>(
    "SELECT status, visit_id FROM plan_items WHERE id = $1",
    [ids.planItemId],
  );
  expect(itemAfterChart.rows[0]).toEqual({ status: "done", visit_id: ids.ownVisit });

  const chartRead = await clinical.readCanonicalPatientChart(await fx.session("ownDoctor"), ids.ownPatient);
  expect(chartRead.records.some(r => r.toothCode === 16 && r.condition === "filling")).toBe(true);

  // 2. Clinical context: ownDoctor lacks clinical.plans.view -> 403 plans_view_required when planId requested; ownerDoctor succeeds
  await expect(
    clinical.readCanonicalClinicalContext(
      await fx.session("ownDoctor"),
      String(ids.ownPatient),
      new URLSearchParams({ planId: String(ids.planId) }),
    ),
  ).rejects.toMatchObject({ status: 403, code: "plans_view_required" });

  const ownerCtx = await clinical.readCanonicalClinicalContext(
    await fx.session("ownerDoctor"),
    String(ids.ownPatient),
    new URLSearchParams({ planId: String(ids.planId), planItemId: String(ids.planItemId) }),
  );
  expect(ownerCtx.ok).toBe(true);

  // 3. Structured diagnosis versioning
  const diag1 = await clinical.commandCanonicalDiagnosisCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    { content: { skeletal: "Class I", dental: "Class I", crowding: "ازدحام خفيف 2 مم" }, label: "تشخيص أولي" },
    fx.pool,
  );
  expect(diag1.version).toBe(1);

  const diag2 = await clinical.commandCanonicalDiagnosisCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    { content: { skeletal: "Class I", dental: "Class I", crowding: "انتظم القوس" }, label: "متابعة" },
    fx.pool,
  );
  expect(diag2.version).toBe(2);
  expect(diag2.id).toBeGreaterThan(diag1.id);

  // 4. Structured problems + status transition
  const problem = await clinical.commandCanonicalProblemCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    { label: "حساسية عنقية سن 44", site: "44", specialty: "general" },
    fx.pool,
  );
  expect(problem.status).toBe("active");

  const resolvedProblem = await clinical.commandCanonicalProblemStatus(
    await fx.session("ownDoctor"),
    String(problem.id),
    { status: "resolved" },
    fx.pool,
  );
  expect(resolvedProblem.status).toBe("resolved");

  // 5. Vitals & staff-captured intake history + none-scope refusal
  const vitals = await clinical.commandCanonicalVitalsCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    { bpSystolic: 120, bpDiastolic: 80, pulse: 74, spo2: 99 },
    fx.pool,
  );
  expect(vitals.bpSystolic).toBe(120);

  const intake = await clinical.commandCanonicalIntakeCreate(
    await fx.session("ownDoctor"),
    String(ids.ownPatient),
    {
      conditions: ["hypertension"],
      allergies: "لا يوجد جديد",
      emergencyName: "أحمد الكامل",
      emergencyPhone: "777888999",
    },
    fx.pool,
  );
  expect(intake.id).toBeGreaterThan(0);

  await expect(
    clinical.commandCanonicalVitalsCreate(
      await fx.session("noneScopeDoctor"),
      String(ids.ownPatient),
      { pulse: 72 },
      fx.pool,
    ),
  ).rejects.toThrow();
});
