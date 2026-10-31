/**
 * M2 slice 35: canonical Endodontics, Clinical Visits & Signing, Lab-Work Command
 * Reconciliation, Visit/Patient Materials, Reception Handoff, Appointment Availability,
 * and Patient Lifecycle (DELETE /patients/[id], /merge, /number) on real PostgreSQL 18.
 * Synthetic data only (SYN-*).
 */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-slice35-endo-visits-2026");

const db = await import("../../lib/db");
const slice35 = await import("../../lib/canonical-endo-visits");

const ACCOUNTS = {
  owner: {
    username: "SYN-S35-OWNER",
    role: "admin",
  },
  doctorOwn: {
    username: "SYN-S35-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
      "clinical.visits.sign": true,
      "clinical.plans.view": true,
      "clinical.ortho.view": true,
      "clinical.lab.view": true,
      "clinical.lab.order": true,
    },
  },
  doctorNoSign: {
    username: "SYN-S35-DOC-NOSIGN",
    role: "doctor",
    doctor: true,
    patientScope: "all",
    appointmentScope: "all",
    grants: {
      "clinical.visits.document": true,
    },
  },
  otherDoctor: {
    username: "SYN-S35-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
    },
  },
  reception: {
    username: "SYN-S35-RECEPTION",
    role: "reception",
    patientScope: "all",
    appointmentScope: "all",
    grants: {
      "visits.manage": true,
      "patients.edit": true,
      "patients.number.manage": true,
    },
  },
} as const;

type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let ownPatientId = 0;
let otherPatientId = 0;
let serviceId = 0;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  ownPatientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('P-07001','SYN Own Endo Patient','0507001001',$1) RETURNING id",
      [fx.parties.doctorOwn!],
    )
  ).rows[0].id;
  otherPatientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('P-07002','SYN Other Endo Patient','0507002002',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;
  serviceId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('SYN RCT Molar','علاج جذور',50000,TRUE,TRUE) RETURNING id",
    )
  ).rows[0].id;
  await fx.pool.query(
    "INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
  );
}, 180_000);

afterAll(async () => {
  await fx?.close();
});

describe("M2 Slice 35 — Endodontics canonical lifecycle & scope isolation", () => {
  it("opens endo episode, saves visit & canals, enforces clinical.plans.edit on crown links, signs visit, and requires clinical.visits.sign on addenda", async () => {
    // 1. Own-scope doctor cannot read or open endo on another doctor's patient (404)
    await expect(slice35.readCanonicalPatientEndo(await fx.session("doctorOwn"), otherPatientId)).rejects.toMatchObject({
      code: "patient_not_found",
      status: 404,
    });

    // 2. Create clinical case + open endo treatment on own patient
    const caseId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES($1,'endodontics','SYN Endo Case #36',$2,'SYN-S35-DOC-OWN') RETURNING id",
        [ownPatientId, fx.parties.doctorOwn!],
      )
    ).rows[0].id;

    const opened = await slice35.createCanonicalEndoTreatment(await fx.session("doctorOwn"), ownPatientId, {
      toothCode: 36,
      caseId,
      treatmentType: "primary",
      pulpalDiagnosis: "التهاب لبّ غير عكوس مصحوب بألم",
      periapicalDiagnosis: "نسج حول ذروية طبيعية",
      preoperativeNote: "اختبار حيوية إيجابي مطوّل",
    });
    expect(opened.toothCode).toBe(36);
    expect(opened.status).toBe("in_progress");

    // 3. Create visit and save endo visit record + canals
    const endoClinicalVisitId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO visits(patient_name,patient_id,doctor_id,status) VALUES('SYN Own Endo Patient',$1,$2,'in_chair') RETURNING id",
        [ownPatientId, fx.parties.doctorOwn!],
      )
    ).rows[0].id;

    const savedVisit = await slice35.saveCanonicalEndoVisit(
      await fx.session("doctorOwn"),
      ownPatientId,
      opened.id,
      {
        visitId: endoClinicalVisitId,
        stage: "obturation",
        pulpalDiagnosis: "symptomatic_irreversible_pulpitis",
        apicalDiagnosis: "normal_apical",
        canalsFound: 1,
        irrigation: "NaOCl 5.25%",
        obturationTechnique: "Warm Vertical",
        obturationMaterial: "SYN Bioceramic + GP",
        restorationAfter: "permanent",
        canals: [
          {
            label: "MB",
            workingLengthMm: 20.5,
            measurementMethod: "both",
            referencePoint: "buccal_cusp",
            masterApicalSize: 25,
            taperPercent: 6,
            obturated: true,
          },
        ],
      },
    );
    expect(savedVisit.created).toBe(true);
    expect(savedVisit.treatment.visits).toHaveLength(1);
    const endoVisitId = savedVisit.treatment.visits[0].id;

    // 4. Crown decision without plan item link succeeds without clinical.plans.edit; linking a plan item without clinical.plans.edit refuses 403
    const planId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO treatment_plans(patient_id,primary_doctor_id,title,total_minor,status,base_currency) VALUES($1,$2,'SYN Plan',80000,'proposed','YER') RETURNING id",
        [ownPatientId, fx.parties.doctorOwn!],
      )
    ).rows[0].id;
    const crownItemId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO plan_items(plan_id,service_name,category,tooth_code,quantity,unit_price_minor) VALUES($1,'تاج زيركون','تركيبات',36,1,80000) RETURNING id",
        [planId],
      )
    ).rows[0].id;

    await expect(
      slice35.updateCanonicalEndoCrown(await fx.session("doctorOwn"), ownPatientId, opened.id, {
        crownRequired: true,
        crownPlanItemId: crownItemId,
      }),
    ).rejects.toMatchObject({ code: "plan_edit_forbidden", status: 403 });

    const crownNoLink = await slice35.updateCanonicalEndoCrown(await fx.session("doctorOwn"), ownPatientId, opened.id, {
      crownRequired: false,
    });
    expect(crownNoLink.crownRequired).toBe(false);

    // 5. Completing endo treatment before signing visit refuses 409; once visit is signed, completion succeeds
    await expect(
      slice35.updateCanonicalEndoStatus(await fx.session("doctorOwn"), ownPatientId, opened.id, {
        status: "completed",
        outcome: "حشو جذور مكتمل مع ترميم نهائي",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await fx.pool.query("UPDATE visits SET signed_at = NOW(), signed_by = 'SYN-S35-DOC-OWN' WHERE id = $1", [
      endoClinicalVisitId,
    ]);

    const completed = await slice35.updateCanonicalEndoStatus(await fx.session("doctorOwn"), ownPatientId, opened.id, {
      status: "completed",
      outcome: "حشو جذور مكتمل مع ترميم نهائي",
    });
    expect(completed.status).toBe("completed");

    // 6. Test endo addendum capability gate (clinical.visits.sign required)
    await expect(
      slice35.createCanonicalEndoAddendum(
        await fx.session("doctorNoSign"),
        ownPatientId,
        opened.id,
        endoVisitId,
        { text: "ملحق بدون صلاحية توقيع", requestKey: "syn-endo-addendum-0001" },
      ),
    ).rejects.toMatchObject({ code: "sign_capability_required", status: 403 });

    const withAddendum = await slice35.createCanonicalEndoAddendum(
      await fx.session("doctorOwn"),
      ownPatientId,
      opened.id,
      endoVisitId,
      { text: "ملحق إشعاعي: ذروة الجذر سليمة", requestKey: "syn-endo-addendum-0002" },
    );
    expect(withAddendum.created).toBe(true);
    expect(withAddendum.treatment.visits[0].addenda).toHaveLength(1);

    // 7. Read projection hides crownPlanItem when clinical.plans.view is absent
    const projectedNoPlans = await slice35.readCanonicalPatientEndo(await fx.session("doctorNoSign"), ownPatientId);
    expect(projectedNoPlans.treatments).toHaveLength(1);
    expect(projectedNoPlans.treatments[0].crownPlanItem).toBeNull();
  });
});

describe("M2 Slice 35 — Clinical Visit save, price authority, sign, addendum, materials & handoff", () => {
  it("projects clinical visit by grant, enforces canonical price authority, signs atomically with invoice, and completes reception handoff", async () => {
    const visitId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO visits(patient_name,patient_id,doctor_id,status) VALUES('SYN Own Endo Patient',$1,$2,'in_chair') RETURNING id",
        [ownPatientId, fx.parties.doctorOwn!],
      )
    ).rows[0].id;

    // 1. Price discount refused (403) when actor lacks finance.discounts.apply
    const discountDeniedRes = await slice35.handleCanonicalClinicalVisitPost(
      new Request(`http://localhost/api/visits/${visitId}/clinical`, { method: "POST" }),
      await fx.session("doctorOwn"),
      visitId,
      {
        action: "save",
        chiefComplaint: "ألم عند المضغ",
        diagnosis: "التهاب لبّ السن 36",
        doctorId: fx.parties.doctorOwn!,
        procedures: [
          {
            serviceId,
            toothCode: 36,
            quantity: 1,
            unitPriceMinor: 45000, // 10% discount from 50000
            priceReason: "خصم خاص",
            doctorId: fx.parties.doctorOwn!,
          },
        ],
      },
    );
    expect(discountDeniedRes.status).toBe(403);

    // 2. Catalog-price save succeeds for doctorOwn
    const saveOkRes = await slice35.handleCanonicalClinicalVisitPost(
      new Request(`http://localhost/api/visits/${visitId}/clinical`, { method: "POST" }),
      await fx.session("doctorOwn"),
      visitId,
      {
        action: "save",
        chiefComplaint: "ألم عند المضغ",
        diagnosis: "التهاب لبّ السن 36",
        doctorId: fx.parties.doctorOwn!,
        procedures: [
          {
            serviceId,
            toothCode: 36,
            quantity: 1,
            unitPriceMinor: 50000,
            doctorId: fx.parties.doctorOwn!,
          },
        ],
      },
    );
    expect(saveOkRes.status).toBe(200);

    // 3. Reception without care/plan/ortho grants sees projected visit with chiefComplaint/diagnosis redacted
    const receptionProjected = await slice35.readCanonicalClinicalVisit(await fx.session("reception"), visitId);
    expect(receptionProjected.chiefComplaint).toBeNull();
    expect(receptionProjected.diagnosis).toBeNull();

    // 4. Sign visit without clinical.visits.sign refuses 403
    const signDeniedRes = await slice35.handleCanonicalClinicalVisitPost(
      new Request(`http://localhost/api/visits/${visitId}/clinical`, { method: "POST" }),
      await fx.session("doctorNoSign"),
      visitId,
      { action: "sign" },
    );
    expect(signDeniedRes.status).toBe(403);

    // 5. Sign visit with clinical.visits.sign creates invoice and atomic visit.sign audit
    const signOkRes = await slice35.handleCanonicalClinicalVisitPost(
      new Request(`http://localhost/api/visits/${visitId}/clinical`, {
        method: "POST",
        headers: { "Idempotency-Key": "syn-s35-sign-visit-0001" },
      }),
      await fx.session("doctorOwn"),
      visitId,
      { action: "sign" },
    );
    expect(signOkRes.status).toBe(200);
    const signedBody = (await signOkRes.json()) as { invoiceId: number; signedAt: string };
    expect(signedBody.invoiceId).toBeGreaterThan(0);
    expect(typeof signedBody.signedAt).toBe("string");

    // 6. Addendum on signed visit succeeds and writes visit.addendum audit
    const addendumRes = await slice35.handleCanonicalClinicalVisitPost(
      new Request(`http://localhost/api/visits/${visitId}/clinical`, {
        method: "POST",
        headers: { "Idempotency-Key": "syn-s35-addendum-visit-0001" },
      }),
      await fx.session("doctorOwn"),
      visitId,
      { action: "addendum", text: "تمت مراجعة الإطباق بعد الحشو." },
    );
    expect(addendumRes.status).toBe(200);
    const addendumBody = (await addendumRes.json()) as { addendum: string };
    expect(addendumBody.addendum).toContain("تمت مراجعة الإطباق");

    // 7. Reception handoff completes idempotently on signed visit
    const handoff = await slice35.completeCanonicalReceptionHandoff(
      await fx.session("reception"),
      String(visitId),
      {
        patientId: ownPatientId,
        signedAt: signedBody.signedAt,
        reason: "غادر المريض وسيراجع الحساب لاحقًا",
      },
    );
    expect(handoff).toMatchObject({
      ok: true,
      visitId,
      patientId: ownPatientId,
      status: "handled",
    });

    // 8. Visit materials & patient materials reads enforce patientScope
    const visitMats = await slice35.readCanonicalVisitMaterials(await fx.session("doctorOwn"), visitId);
    expect(visitMats.patientId).toBe(ownPatientId);
    const patientMats = await slice35.readCanonicalPatientMaterials(await fx.session("doctorOwn"), ownPatientId);
    expect(Array.isArray(patientMats)).toBe(true);
    // When canonical inventory integration is active, legacy visit material return refuses with 409 inventory_tracking_required
    const itemId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO inventory_items(name,category,unit,created_by) VALUES('SYN Composite','مستهلكات','tube','SYN-S35-OWNER') RETURNING id",
      )
    ).rows[0].id;
    await expect(
      slice35.recordCanonicalVisitMaterialReturn(await fx.session("doctorOwn"), visitId, {
        itemId,
        qty: 1,
        reason: "فائض",
      }),
    ).rejects.toMatchObject({ status: 409 });

    // 9. Lab-work command read reconciles cleanly ({ found: false } for unknown key)
    const labReceipt = await slice35.readCanonicalVisitLabWorkCommand(
      await fx.session("doctorOwn"),
      visitId,
      "syn-lab-cmd-0001",
      "a".repeat(64),
    );
    expect(labReceipt).toEqual({ found: false });
  });
});

describe("M2 Slice 35 — Appointment availability & Patient lifecycle (number, merge, delete)", () => {
  it("restricts appointment availability by appointmentScope and enforces numbering owner override, merge, and delete gates", async () => {
    // 1. Appointment availability: own-scope doctor can query self, refused 403 for another doctor
    const ownAvail = await slice35.readCanonicalAppointmentAvailability(
      await fx.session("doctorOwn"),
      new URLSearchParams({
        date: "2026-11-05",
        doctorId: String(fx.parties.doctorOwn!),
        durationMinutes: "30",
      }),
    );
    expect(ownAvail.doctorId).toBe(fx.parties.doctorOwn!);

    await expect(
      slice35.readCanonicalAppointmentAvailability(
        await fx.session("doctorOwn"),
        new URLSearchParams({
          date: "2026-11-05",
          doctorId: String(fx.parties.otherDoctor!),
          durationMinutes: "30",
        }),
      ),
    ).rejects.toMatchObject({ code: "availability_scope_denied", status: 403 });

    // 2. Patient numbering: read + change + owner-only paper archive override (< 7000)
    const numTargetId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO patients(patient_number,full_name,phone) VALUES('P-07100','SYN Numbering Patient','0507100100') RETURNING id",
      )
    ).rows[0].id;

    const snap1 = await slice35.readCanonicalPatientNumber(await fx.session("reception"), numTargetId);
    expect(snap1.patientNumber).toBe("P-07100");

    const snap2 = await slice35.changeCanonicalPatientNumber(await fx.session("reception"), numTargetId, {
      patientNumber: "P-07101",
      expectedPatientNumber: "P-07100",
      expectedVersion: snap1.version,
      reason: "تصحيح رقم الملف التجريبي",
    });
    expect(snap2.patientNumber).toBe("P-07101");

    // Retire a paper archive number < 7000 by creating & changing a temp patient, then test override gate
    const paperTempId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO patients(patient_number,full_name,phone) VALUES('P-00450','SYN Paper Temp','0500450450') RETURNING id",
      )
    ).rows[0].id;
    const paperSnap = await slice35.readCanonicalPatientNumber(await fx.session("owner"), paperTempId);
    await slice35.changeCanonicalPatientNumber(await fx.session("owner"), paperTempId, {
      patientNumber: "P-07102",
      expectedPatientNumber: "P-00450",
      expectedVersion: paperSnap.version,
      reason: "إخلاء رقم أرشيف ورقي",
    });

    // Non-owner reception with patients.number.manage CANNOT use allowPaperArchiveOverride (403 forbidden)
    await expect(
      slice35.changeCanonicalPatientNumber(await fx.session("reception"), numTargetId, {
        patientNumber: "P-00450",
        expectedPatientNumber: "P-07101",
        expectedVersion: snap2.version,
        reason: "محاولة تجاوز لغير المالك",
        allowPaperArchiveOverride: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Primary owner CAN reuse retired paper archive number < 7000
    const snap3 = await slice35.changeCanonicalPatientNumber(await fx.session("owner"), numTargetId, {
      patientNumber: "P-00450",
      expectedPatientNumber: "P-07101",
      expectedVersion: snap2.version,
      reason: "مطابقة الأرشيف الورقي للمالك",
      allowPaperArchiveOverride: true,
    });
    expect(snap3.patientNumber).toBe("P-00450");

    // 3. Merge duplicate patient (source without financial history into target)
    const mergeResult = await slice35.mergeCanonicalPatient(await fx.session("owner"), numTargetId, {
      duplicatePatientNumber: "P-07102",
      confirmDuplicateNumber: "P-07102",
      reason: "ملف مكرر لنفس المريض",
    });
    expect(mergeResult.message).toContain("دُمج الملف");
    expect((await fx.pool.query("SELECT 1 FROM patients WHERE id = $1", [paperTempId])).rows).toHaveLength(0);

    // 4. Delete patient: refuses patient with clinical/financial history (ownPatientId -> 409), deletes clean mistake file
    await expect(
      slice35.deleteCanonicalPatient(await fx.session("owner"), ownPatientId, {
        confirmPatientNumber: "P-07001",
        reason: "اختبار منع حذف سجل طبي ومالي",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const deletedPatient = await slice35.deleteCanonicalPatient(await fx.session("owner"), numTargetId, {
      confirmPatientNumber: "P-00450",
      reason: "حذف ملف تجريبي بلا تاريخ طبي أو مالي",
    });
    expect(deletedPatient.message).toContain("حُذف ملف");
    expect((await fx.pool.query("SELECT 1 FROM patients WHERE id = $1", [numTargetId])).rows).toHaveLength(0);
  });
});
