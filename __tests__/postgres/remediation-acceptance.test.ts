import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";

/**
 * اختبارات القبول الشاملة للإصلاحات الموحّدة على PostgreSQL 18.6:
 * تغطي الأمان السريري (CLIN-01/02/06/07)، وصلاحيات ونطاق الأطباء (SEC-01)،
 * وفصل الذمم (FIN-01)، والمخزون ومرتجعات الزيارة والموردين (INV-01/02)،
 * والموارد البشرية وتصحيح الحضور وتهيئة الإجازات والخدمة الذاتية (HR-02).
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.CLINIC_TIME_ZONE = "Asia/Aden";
process.env.SESSION_SECRET ??= "synthetic-remediation-acceptance-secret-2026";

const db = await import("../../lib/db");
const {
  ensureSchema,
  getPool,
  resetPoolForTesting,
  saveSettings,
  seedAppointmentServices,
  listAppointmentServices,
  createParty,
  createPatient,
  saveMedicalHistory,
  listMedicalHistory,
  createLabOrder,
  listLabOrders,
  addVisit,
  createInventoryMovement,
} = db;
const { normalizeMedicalHistory } = await import("../../lib/medical-history");
const { evaluatePrescriptionSafety } = await import("../../lib/medication-safety");
const { canAccessPatient } = await import("../../lib/patient-access");
const { bookAppointment } = await import("../../lib/book-appointment");
const { returnVisitMaterial, listVisitMaterialReturns } = await import("../../lib/inventory-visit-returns");
const { hashPassword, sessionCredentialVersion } = await import("../../lib/auth");
const hr = await import("../../lib/hr");
const work = await import("../../lib/hr-contracts-attendance");
const { getMyHrSummary } = await import("../../lib/hr-self-service");

let ownerSession: SessionPayload;
let restrictedDoctorSession: SessionPayload;
let doctorPartyId = 0;
let providerServiceId = 0;

beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl());
  await ensureSchema();
  await getPool().query(`DELETE FROM users`);

  const passHash = await hashPassword("Accept@123456");
  const credVer = sessionCredentialVersion(passHash);

  const docParty = await createParty({
    name: "د. سامي المقيّد",
    kind: "doctor",
    phone: "777000111",
    commissionPercent: 35,
    note: null,
  });
  doctorPartyId = docParty.id;

  const { rows: insertedUsers } = await getPool().query<{ id: number; username: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, is_owner, party_id, permissions)
     VALUES
       ('sole-owner', 'د. عقلان (المالك)', $1, 'admin', TRUE, NULL, NULL),
       ('doc-scoped', 'د. سامي المقيّد', $1, 'doctor', FALSE, $2, '{"canViewAllPatients":false}'::jsonb)
     RETURNING id, username`,
    [passHash, doctorPartyId],
  );

  const ownerRow = insertedUsers.find((u) => u.username === "sole-owner")!;
  const docRow = insertedUsers.find((u) => u.username === "doc-scoped")!;

  ownerSession = {
    userId: ownerRow.id,
    username: "sole-owner",
    role: "admin",
    credentialVersion: credVer,
    expiresAt: Date.now() + 3_600_000,
  };
  restrictedDoctorSession = {
    userId: docRow.id,
    username: "doc-scoped",
    role: "doctor",
    partyId: doctorPartyId,
    credentialVersion: credVer,
    expiresAt: Date.now() + 3_600_000,
  };

  await seedAppointmentServices();
  const services = await listAppointmentServices();
  providerServiceId = services.find((s) => s.requiresProvider && s.isActive)!.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("Remediation Acceptance Suite (PG18)", () => {
  it("(CLIN-01) evaluates prescription drug safety against structured medical history allergies and anticoagulants", async () => {
    const patient = await createPatient({
      fullName: "مريض حساسية كليندامايسين",
      phone: "771112233",
      altPhone: null,
      gender: "male",
      birthYear: 1985,
      address: null,
      medicalAlert: null,
      note: null,
    });
    const parsed = normalizeMedicalHistory({
      answers: { anticoagulants: "yes" },
      allergies: [{ substance: "Clindamycin", severity: "severe", reaction: "صدمة تحسسية" }],
      asaClass: "II",
      patientConfirmed: true,
    });
    if (!parsed.ok) throw new Error(parsed.message);
    await saveMedicalHistory(patient.id, parsed.value, "sole-owner");

    const [latest] = await listMedicalHistory(patient.id);
    const alerts = evaluatePrescriptionSafety(
      [{ name: "Clindamycin 300mg" }, { name: "Ibuprofen 400mg" }],
      patient.medicalAlert,
      latest,
    );
    expect(alerts.some((a) => a.severity === "critical" && a.medicationName.includes("Clindamycin"))).toBe(true);
    expect(alerts.some((a) => a.contraindicatedRiskId === "bleeding_disorder")).toBe(true);
  });

  it("(SEC-01) blocks restricted doctor from unrelated patient until an active internal referral is granted", async () => {
    const patient = await createPatient({
      fullName: "مريض خارج النطاق",
      phone: null,
      altPhone: null,
      gender: "female",
      birthYear: 1995,
      address: null,
      medicalAlert: null,
      note: null,
    });

    expect(await canAccessPatient(restrictedDoctorSession, patient.id)).toBe(false);

    const referringDoc = await createParty({
      name: "د. أروى المحيلة",
      kind: "doctor",
      phone: null,
      commissionPercent: 40,
      note: null,
    });
    const refCreated = await db.createInternalReferral({
      patientId: patient.id,
      doctorPartyId: referringDoc.id,
      toPartyId: doctorPartyId,
      toSpecialty: "endodontics",
      reason: "إحالة داخلية للفحص وعلاج العصب",
      teeth: "16",
      urgency: "routine",
      caseId: null,
      blocksCaseId: null,
      planItemId: null,
      requestedServiceId: null,
      actor: "sole-owner",
      actorRole: "admin",
    });
    expect(refCreated.ok).toBe(true);

    expect(await canAccessPatient(restrictedDoctorSession, patient.id)).toBe(true);
  });

  it("(FIN-01) supports employee party kind cleanly without polluting patients", async () => {
    const { rows: beforePatients } = await getPool().query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM patients`);
    const empParty = await createParty({
      name: "موظف استقبال مستقل",
      kind: "employee",
      phone: "770000999",
      commissionPercent: 0,
      note: "ذمة موظف منفصلة عن المرضى",
    });
    expect(empParty.kind).toBe("employee");
    const { rows: afterPatients } = await getPool().query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM patients`);
    expect(afterPatients[0].c).toBe(beforePatients[0].c);
  });

  it("(CLIN-02 & CLIN-06) keeps active lab orders visible and accepts multi-session in_progress + incisal surface 'I'", async () => {
    const patient = await createPatient({
      fullName: "مريض معمل وجلسات",
      phone: null,
      altPhone: null,
      gender: "male",
      birthYear: 1992,
      address: null,
      medicalAlert: null,
      note: null,
    });

    const labOrder = await createLabOrder({
      patientId: patient.id,
      labName: "معمل الدقة للزيركون",
      labPhone: null,
      workType: "تاج زيركون",
      details: null,
      sentDate: "2026-10-30",
      dueDate: "2026-11-05",
      status: "sent",
      partyId: null,
      costMinor: 25000,
      costCurrency: "YER",
      baseCurrency: "YER",
      exchangeRate: 1,
      note: "لون A2",
      createdBy: "sole-owner",
      actorRole: "admin",
    });
    expect(labOrder).not.toBeNull();
    const activeOrders = await listLabOrders({ patientId: patient.id });
    expect(activeOrders.some((o) => o.id === labOrder!.id && o.status === "sent")).toBe(true);

    const toothRec = await db.recordToothCondition({
      patientId: patient.id,
      toothCode: 11,
      condition: "filling",
      stage: "completed",
      surfaces: "MI",
      note: "حشوة قاطعة إنسية",
      visitId: null,
      recordedBy: "sole-owner",
    });
    expect(toothRec?.surfaces).toBe("MI");

    const { rows: [svc] } = await getPool().query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category)
       VALUES ('علاج عصب على جلستين', 60000, TRUE, TRUE, 'endo') RETURNING id`,
    );
    const plan = await db.createPlanV2({
      patientId: patient.id,
      title: "خطة جلسات متعددة",
      specialty: "علاج عصب",
      primaryDoctorId: doctorPartyId,
      billingMode: "per_procedure",
      baseCurrency: "YER",
      startDate: "2026-10-30",
      note: null,
      createdBy: "sole-owner",
      items: [
        {
          serviceId: svc.id,
          serviceName: "علاج عصب على جلستين",
          category: "endo",
          toothCode: 11,
          surfaces: "I",
          quantity: 1,
          unitPriceMinor: 60000,
          billingRule: "per_session",
          sessionCount: 2,
          note: null,
        },
      ],
      installments: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.message);
    const { rows: [planItem] } = await getPool().query<{ status: string; surfaces: string }>(
      `UPDATE plan_items SET status = 'in_progress' WHERE plan_id = $1 RETURNING status, surfaces`,
      [plan.planId],
    );
    expect(planItem).toEqual({ status: "in_progress", surfaces: "I" });
  });

  it("(CLIN-07) enforces Friday closure, strict working hours, and approved HR doctor leave during booking", async () => {
    await saveSettings({
      "clinic.chairs": "3",
      "clinic.day_start": "09:00",
      "clinic.day_end": "17:00",
      "clinic.shift2_start": "",
      "clinic.shift2_end": "",
      "scheduling.strict_hours": "true",
      "clinic.closed_weekdays": "5",
    });

    const patient = await createPatient({
      fullName: "مريض جدولة المواعيد",
      phone: null,
      altPhone: null,
      gender: "male",
      birthYear: 1988,
      address: null,
      medicalAlert: null,
      note: null,
    });
    const actor = { username: "sole-owner", role: "admin" as const, channel: "ui" as const };

    // 2031-01-03 is Friday (weekday 5)
    const fridayAttempt = await bookAppointment(
      { patientId: patient.id, date: "2031-01-03", time: "10:00", durationMinutes: 30, doctorId: doctorPartyId, serviceId: providerServiceId },
      actor,
    );
    expect(fridayAttempt.ok).toBe(false);

    // 2031-01-04 is Saturday, 21:00 is outside 09:00..17:00 strict hours
    const afterHoursAttempt = await bookAppointment(
      { patientId: patient.id, date: "2031-01-04", time: "21:00", durationMinutes: 30, doctorId: doctorPartyId, serviceId: providerServiceId },
      actor,
    );
    expect(afterHoursAttempt.ok).toBe(false);

    // Link doctorPartyId to an HR staff member with an approved leave on 2031-01-06
    const docStaff = await hr.createStaff(
      {
        fullName: "د. سامي المقيّد",
        department: "doctors",
        jobTitle: "طبيب أسنان",
        hireDate: "2026-01-01",
        workStatus: "active",
        contractKind: "commission",
        endDate: null,
        phone: null,
        note: null,
        payTerms: null,
      },
      ownerSession,
    );
    const linkRes = await hr.setStaffUserLink(docStaff.id, restrictedDoctorSession.userId, "ربط حساب الطبيب بملفه الوظيفي", ownerSession);
    expect(linkRes.ok).toBe(true);
    await work.adjustLeaveBalance({ staffId: docStaff.id, leaveTypeCode: "annual", year: 2031, allocatedDays: 21 }, ownerSession);
    const leaveReq = await work.createLeaveRequest(
      { staffId: docStaff.id, leaveTypeCode: "annual", startDate: "2031-01-06", endDate: "2031-01-06", daysCount: 1, reason: "إجازة سنوية" },
      ownerSession,
    );
    await work.decideLeaveRequest(leaveReq.id, "approved", "اعتماد إجازة الطبيب", ownerSession);

    const onLeaveAttempt = await bookAppointment(
      { patientId: patient.id, date: "2031-01-06", time: "10:00", durationMinutes: 30, doctorId: doctorPartyId, serviceId: providerServiceId },
      actor,
    );
    expect(onLeaveAttempt.ok).toBe(false);

    const validAttempt = await bookAppointment(
      { patientId: patient.id, date: "2031-01-07", time: "10:00", durationMinutes: 30, doctorId: doctorPartyId, serviceId: providerServiceId },
      actor,
    );
    expect(validAttempt.ok).toBe(true);
  });

  it("(INV-02) returns excess visit material safely and creates negative payable adjustment on supplier return", async () => {
    const supplier = await createParty({
      name: "مؤسسة الأمل للمستلزمات",
      kind: "supplier",
      phone: "773334455",
      commissionPercent: 0,
      note: null,
    });
    const patient = await createPatient({
      fullName: "مريض مواد الزيارة",
      phone: null,
      altPhone: null,
      gender: "male",
      birthYear: 1990,
      address: null,
      medicalAlert: null,
      note: null,
    });
    const visit = await addVisit({
      patientName: patient.fullName,
      patientPhone: null,
      note: null,
      patientId: patient.id,
      doctorId: doctorPartyId,
    });

    const { rows: [item] } = await getPool().query<{ id: number }>(
      `INSERT INTO inventory_items (name, category, unit, min_level, created_by)
       VALUES ('كمبوزيت اختبار قبول', 'filling', 'سرنجة', 2, 'sole-owner') RETURNING id`,
    );
    const stocked = await createInventoryMovement({
      itemId: item.id,
      kind: "in",
      qty: 10,
      unitCostMinor: 5000,
      supplierPartyId: supplier.id,
      reason: "توريد اختباري",
      createdBy: "sole-owner",
    });
    expect(stocked.ok).toBe(true);

    const { rows: [payable] } = await getPool().query<{ id: number }>(
      `SELECT id FROM payables WHERE party_id = $1 ORDER BY id DESC LIMIT 1`,
      [supplier.id],
    );
    expect(payable?.id).toBeGreaterThan(0);

    const consumed = await createInventoryMovement({
      itemId: item.id,
      kind: "out",
      qty: 4,
      visitId: visit.id,
      patientId: patient.id,
      reason: "صرف للزيارة",
      createdBy: "sole-owner",
    });
    expect(consumed.ok).toBe(true);

    const returned = await returnVisitMaterial({
      visitId: visit.id,
      itemId: item.id,
      qty: 1.5,
      reason: "فائض غير مستخدم",
      createdBy: "sole-owner",
    });
    expect(returned).toMatchObject({ ok: true, balance: 7.5 });
    const returnLines = await listVisitMaterialReturns(visit.id);
    expect(returnLines).toHaveLength(1);
    expect(returnLines[0].qty).toBe(1.5);

    const overReturn = await returnVisitMaterial({
      visitId: visit.id,
      itemId: item.id,
      qty: 3,
      reason: "محاولة تجاوز",
      createdBy: "sole-owner",
    });
    expect(overReturn).toMatchObject({ ok: false, status: 409 });

    const supplierReturn = await createInventoryMovement({
      itemId: item.id,
      kind: "out",
      isReturn: true,
      qty: 2,
      unitCostMinor: 5000,
      supplierPartyId: supplier.id,
      returnPayableId: payable.id,
      reason: "مرتجع للمورد مع إشعار دائن",
      createdBy: "sole-owner",
    });
    expect(supplierReturn.ok).toBe(true);

    const { rows: adjRows } = await getPool().query<{ delta_minor: string }>(
      `SELECT delta_minor::text FROM payable_adjustments WHERE payable_id = $1`,
      [payable.id],
    );
    expect(adjRows.map((r) => Number(r.delta_minor))).toContain(-10000);
  });

  it("(HR-02) initializes annual leave on contract approval, prevents sole-owner attendance deadlock, and serves /hr/me", async () => {
    const emp = await hr.createStaff(
      {
        fullName: "سارة المحاسبة",
        department: "accounting",
        jobTitle: "محاسبة",
        hireDate: "2026-02-01",
        workStatus: "active",
        contractKind: "salary",
        endDate: null,
        phone: "775556677",
        note: null,
        payTerms: { amountMinor: 120000, currency: "YER", period: "monthly", effectiveOn: "2026-02-01" },
      },
      ownerSession,
    );

    await work.createSchedule(
      {
        staffId: emp.id,
        name: "دوام صباحي",
        scheduleType: "morning",
        effectiveFrom: "2026-01-01",
        workingDays: [0, 1, 2, 3, 4, 6],
        shiftStartTime: "08:00",
        shiftEndTime: "16:00",
        gracePeriodMins: 15,
      },
      ownerSession,
    );

    const draft = await work.createContract(
      {
        staffId: emp.id,
        templateKind: "support_staff",
        title: "عقد عمل سارة 2026",
        startDate: "2026-02-01",
        compensationKind: "salary",
        baseSalaryMinor: 120000,
        salaryCurrency: "YER",
        salaryPeriod: "monthly",
        termsPayload: { annualLeaveDays: 24 } as Record<string, unknown>,
      },
      ownerSession,
    );
    await work.updateContract(draft.id, { signedByStaff: true, signedByCenter: true }, ownerSession);
    const approved = await work.approveContract(draft.id, ownerSession);
    expect(approved.status).toBe("approved");

    const balances = await work.listLeaveBalances(emp.id, 2026);
    expect(balances.find((b) => b.leaveTypeCode === "annual")?.allocatedDays).toBe(24);

    // Sole-owner clinic attendance correction recalculates workMinutes without deadlock
    const att = await work.recordAttendance(
      {
        staffId: emp.id,
        attendanceDate: "2026-08-03",
        checkIn: "2026-08-03T08:00:00+03:00",
        checkOut: "2026-08-03T14:00:00+03:00",
      },
      ownerSession,
    );
    expect(att.workMinutes).toBe(360);

    const corr = await work.requestAttendanceCorrection(
      {
        attendanceRecordId: att.id,
        fieldCorrected: "check_out",
        newCheckOut: "2026-08-03T16:00:00+03:00",
        reason: "تصحيح انصراف فعلي للعيادة الفردية",
      },
      ownerSession,
    );
    const decided = await work.decideAttendanceCorrection(corr.id, "approved", "اعتماد المالك الوحيد", ownerSession);
    expect(decided.status).toBe("approved");

    const [updatedAtt] = await work.listAttendanceRecords({ staffId: emp.id });
    expect(updatedAtt.workMinutes).toBe(480);

    // Employee self-service summary works for linked doctor account
    const selfSummary = await getMyHrSummary(restrictedDoctorSession);
    expect(selfSummary.linked).toBe(true);
    expect(selfSummary.staff?.fullName).toContain("سامي");
  });
});
