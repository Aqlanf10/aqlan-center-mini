import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات العزل الخادمي لملفات المرضى (الأولوية الأولى) على PostgreSQL 18 المعزول ببيانات اصطناعية.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  addVisit,
  createLabOrder,
  createPatient,
  ensureSchema,
  getPool,
  insertMessage,
  listLabOrders,
  listTodayVisits,
  listVisitsByDate,
  resetPoolForTesting,
  staffConversationList,
  startVisitFromPlannedVisit,
  unreadMessageCount,
  urgentUnreadMessageCount,
} = await import("../../lib/db");
const { bookAppointment } = await import("../../lib/book-appointment");
const { convertWaitingToAppointment } = await import("../../lib/waiting-list-booking");
const {
  PatientOutOfScopeError,
  canAccessPatient,
  resolveRestrictedDoctorScope,
} = await import("../../lib/patient-access");

import type { SessionPayload } from "../../lib/auth";

let doctorAPartyId = 0;
let doctorBPartyId = 0;
let labPartyId = 0;

let ownerSession: SessionPayload;
let receptionSession: SessionPayload;
let accountantSession: SessionPayload;
let doctorASession: SessionPayload;
let doctorBSession: SessionPayload;
let unlinkedDoctorSession: SessionPayload;

let patientAId = 0;
const patientAPhone = "771100101";
let patientBId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  const { rows: parties } = await pool.query<{ id: number; name: string }>(
    `INSERT INTO parties (name, kind, is_active)
     VALUES ('د. ألف الاصطناعي', 'doctor', TRUE),
            ('د. باء الاصطناعي', 'doctor', TRUE),
            ('مختبر النور الاصطناعي', 'lab', TRUE)
     RETURNING id, name`,
  );
  doctorAPartyId = parties[0].id;
  doctorBPartyId = parties[1].id;
  labPartyId = parties[2].id;

  const { rows: users } = await pool.query<{
    id: number;
    username: string;
    role: "admin" | "reception" | "accountant" | "doctor";
    party_id: number | null;
  }>(
    `INSERT INTO users (username, display_name, password_hash, role, party_id, is_active)
     VALUES ('syn.owner', 'مالك تجريبي', 'scrypt:dummy', 'admin', NULL, TRUE),
            ('syn.reception', 'استقبال تجريبي', 'scrypt:dummy', 'reception', NULL, TRUE),
            ('syn.accountant', 'محاسب تجريبي', 'scrypt:dummy', 'accountant', NULL, TRUE),
            ('syn.doc.a', 'د. ألف', 'scrypt:dummy', 'doctor', $1, TRUE),
            ('syn.doc.b', 'د. باء', 'scrypt:dummy', 'doctor', $2, TRUE),
            ('syn.doc.unlinked', 'طبيب بلا جهة', 'scrypt:dummy', 'doctor', NULL, TRUE)
     RETURNING id, username, role, party_id`,
    [doctorAPartyId, doctorBPartyId],
  );

  const toSession = (u: (typeof users)[number]): SessionPayload => ({
    userId: u.id,
    username: u.username,
    role: u.role,
    partyId: u.party_id,
    expiresAt: Date.now() + 3_600_000,
  });

  ownerSession = toSession(users[0]);
  receptionSession = toSession(users[1]);
  accountantSession = toSession(users[2]);
  doctorASession = toSession(users[3]);
  doctorBSession = toSession(users[4]);
  unlinkedDoctorSession = toSession(users[5]);

  const patientA = await createPatient(
    {
      fullName: "مريض ألف الاصطناعي",
      phone: patientAPhone,
      altPhone: null,
      gender: "male",
      birthYear: 1990,
      address: "صنعاء",
      medicalAlert: null,
      note: null,
    },
    { primaryDoctorId: doctorAPartyId },
  );
  patientAId = patientA.id;

  const patientB = await createPatient(
    {
      fullName: "مريض باء الاصطناعي",
      phone: "772200202",
      altPhone: null,
      gender: "female",
      birthYear: 1994,
      address: "صنعاء",
      medicalAlert: null,
      note: null,
    },
    { primaryDoctorId: doctorBPartyId },
  );
  patientBId = patientB.id;
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("Priority 1 — Server-side Patient Isolation & Witness Prevention", () => {
  it("enforces clinical vs financial access boundaries across Owner, Reception, Accountant, DoctorA, DoctorB, and UnlinkedDoctor", async () => {
    expect(await canAccessPatient(ownerSession, patientAId)).toBe(true);
    expect(await canAccessPatient(receptionSession, patientAId)).toBe(true);
    // Accountant has financial visibility via canViewPatientMoney, NOT clinical chart access via canAccessPatient
    expect(await canAccessPatient(accountantSession, patientAId)).toBe(false);
    expect(await canAccessPatient(doctorASession, patientAId)).toBe(true);

    expect(await canAccessPatient(doctorBSession, patientAId)).toBe(false);
    expect(await canAccessPatient(doctorASession, patientBId)).toBe(false);
    expect(await canAccessPatient(unlinkedDoctorSession, patientAId)).toBe(false);
    expect(await canAccessPatient(unlinkedDoctorSession, patientBId)).toBe(false);
  });

  it("prevents restricted DoctorB from acquiring ownership of PatientA via addVisit (direct ID or walk-in phone match)", async () => {
    await expect(
      addVisit({
        patientName: "مريض ألف الاصطناعي",
        patientPhone: patientAPhone,
        note: "محاولة استحواذ عبر رقم المريض",
        patientId: patientAId,
        doctorId: doctorBPartyId,
        actorSession: doctorBSession,
      }),
    ).rejects.toBeInstanceOf(PatientOutOfScopeError);

    // Walk-in without patientId but matching PatientA's phone must ALSO be blocked before creating a witness
    await expect(
      addVisit({
        patientName: "زائر بنفس هاتف مريض ألف",
        patientPhone: patientAPhone,
        note: "محاولة استحواذ عبر الهاتف",
        patientId: null,
        doctorId: doctorBPartyId,
        actorSession: doctorBSession,
      }),
    ).rejects.toBeInstanceOf(PatientOutOfScopeError);

    // Unlinked doctor blocked fail-closed
    await expect(
      addVisit({
        patientName: "محاولة طبيب غير مربوط",
        patientPhone: null,
        note: null,
        patientId: patientAId,
        actorSession: unlinkedDoctorSession,
      }),
    ).rejects.toBeInstanceOf(PatientOutOfScopeError);

    expect(await canAccessPatient(doctorBSession, patientAId)).toBe(false);
  });

  it("prevents restricted DoctorB from acquiring ownership of PatientA via appointments, planned visits, waiting list, or lab orders", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const bookAttempt = await bookAppointment(
      {
        patientId: patientAId,
        date: tomorrow,
        time: "10:00",
        durationMinutes: 30,
        doctorId: doctorBPartyId,
        note: "محاولة حجز خارج النطاق",
      },
      {
        username: doctorBSession.username,
        role: doctorBSession.role,
        doctorPartyId: doctorBPartyId,
        actorSession: doctorBSession,
        channel: "ui",
      },
    );
    expect(bookAttempt.ok).toBe(false);
    if (!bookAttempt.ok) {
      expect(bookAttempt.status).toBe(403);
    }

    // Seed a treatment plan & planned_visit for PatientA owned by DoctorA, verify DoctorB cannot start a visit from it
    const pool = getPool();
    const { rows: [plan] } = await pool.query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, created_by)
       VALUES ($1, 'خطة تجريبية', 20000, 'YER', 'active', 'syn.doc.a')
       RETURNING id`,
      [patientAId],
    );
    const { rows: [pv] } = await pool.query<{ id: number }>(
      `INSERT INTO planned_visits (plan_id, patient_id, doctor_id, sequence, title, duration_minutes, status)
       VALUES ($1, $2, $3, 1, 'جلسة تحضير', 30, 'planned')
       RETURNING id`,
      [plan.id, patientAId, doctorAPartyId],
    );

    await expect(
      startVisitFromPlannedVisit({
        plannedVisitId: pv.id,
        actor: doctorBSession.username,
        actorRole: doctorBSession.role,
        actorSession: doctorBSession,
      }),
    ).rejects.toBeInstanceOf(PatientOutOfScopeError);

    // Seed a waiting-list row for PatientA and verify DoctorB cannot convert it to gain ownership
    const { rows: [wl] } = await pool.query<{ id: number }>(
      `INSERT INTO waiting_list (patient_id, status)
       VALUES ($1, 'waiting')
       RETURNING id`,
      [patientAId],
    );

    const wlAttempt = await convertWaitingToAppointment(
      {
        waitingId: wl.id,
        date: tomorrow,
        time: "11:00",
        durationMinutes: 30,
        doctorId: doctorBPartyId,
      },
      {
        username: doctorBSession.username,
        role: doctorBSession.role,
        doctorPartyId: doctorBPartyId,
        actorSession: doctorBSession,
        channel: "ui",
      },
    );
    expect(wlAttempt.ok).toBe(false);
    if (!wlAttempt.ok) {
      expect(wlAttempt.status).toBe(403);
    }

    await expect(
      createLabOrder({
        patientId: patientAId,
        labName: "مختبر النور الاصطناعي",
        labPhone: null,
        workType: "تاج زركون",
        details: null,
        sentDate: tomorrow,
        dueDate: tomorrow,
        note: null,
        partyId: labPartyId,
        costMinor: null,
        costCurrency: null,
        baseCurrency: "YER",
        exchangeRate: 1,
        createdBy: doctorBSession.username,
        doctorId: doctorBPartyId,
        actorRole: doctorBSession.role,
        actorSession: doctorBSession,
      }),
    ).rejects.toBeInstanceOf(PatientOutOfScopeError);

    expect(await canAccessPatient(doctorBSession, patientAId)).toBe(false);
  });

  it("isolates list queries (visits, lab orders, conversations, unread counts) while preserving authorized clinic workflow", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const visitA = await addVisit({
      patientName: "مريض ألف الاصطناعي",
      patientPhone: patientAPhone,
      note: "زيارة مشروعة",
      patientId: patientAId,
      doctorId: doctorAPartyId,
      actorSession: doctorASession,
    });
    expect(visitA.patientId).toBe(patientAId);

    const labA = await createLabOrder({
      patientId: patientAId,
      labName: "مختبر النور الاصطناعي",
      labPhone: null,
      workType: "تركيبة خزفية",
      details: "سن 11",
      sentDate: today,
      dueDate: today,
      note: null,
      partyId: labPartyId,
      costMinor: 15000,
      costCurrency: "YER",
      baseCurrency: "YER",
      exchangeRate: 1,
      createdBy: doctorASession.username,
      doctorId: doctorAPartyId,
      actorRole: doctorASession.role,
      actorSession: doctorASession,
    });
    expect(labA?.patientId).toBe(patientAId);

    await insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: patientAId,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      kind: "text",
      body: "عندي ألم شديد بعد الجلسة",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: null,
      fileMime: null,
      fileSize: null,
      fileData: null,
      isUrgent: true,
      replyToId: null,
    });

    const scopeDocA = await resolveRestrictedDoctorScope(doctorASession);
    const scopeDocB = await resolveRestrictedDoctorScope(doctorBSession);
    const scopeUnlinked = await resolveRestrictedDoctorScope(unlinkedDoctorSession);
    const scopeReception = await resolveRestrictedDoctorScope(receptionSession);

    const todayForA = await listTodayVisits(scopeDocA);
    const todayForB = await listTodayVisits(scopeDocB);
    const todayForUnlinked = await listTodayVisits(scopeUnlinked);
    const todayForReception = await listTodayVisits(scopeReception);

    expect(todayForA.some((v) => v.patientId === patientAId)).toBe(true);
    expect(todayForB.some((v) => v.patientId === patientAId)).toBe(false);
    expect(todayForUnlinked).toHaveLength(0);
    expect(todayForReception.some((v) => v.patientId === patientAId)).toBe(true);

    const byDateForB = await listVisitsByDate(visitA.arrivedAt.slice(0, 10), scopeDocB);
    expect(byDateForB.some((v) => v.patientId === patientAId)).toBe(false);

    const labsForA = await listLabOrders({}, scopeDocA);
    const labsForB = await listLabOrders({}, scopeDocB);
    const labsForUnlinked = await listLabOrders({}, scopeUnlinked);
    const labsForReception = await listLabOrders({}, scopeReception);

    expect(labsForA.some((o) => o.patientId === patientAId)).toBe(true);
    expect(labsForB.some((o) => o.patientId === patientAId)).toBe(false);
    expect(labsForUnlinked).toHaveLength(0);
    expect(labsForReception.some((o) => o.patientId === patientAId)).toBe(true);

    const convA = await staffConversationList(doctorASession.userId, scopeDocA);
    const convB = await staffConversationList(doctorBSession.userId, scopeDocB);
    const convUnlinked = await staffConversationList(unlinkedDoctorSession.userId, scopeUnlinked);
    const convReception = await staffConversationList(receptionSession.userId, scopeReception);

    expect(convA.patients.some((p) => p.patientId === patientAId)).toBe(true);
    expect(convB.patients.some((p) => p.patientId === patientAId)).toBe(false);
    expect(convUnlinked.patients).toHaveLength(0);
    expect(convReception.patients.some((p) => p.patientId === patientAId)).toBe(true);

    expect(await unreadMessageCount(doctorASession.userId, scopeDocA)).toBeGreaterThanOrEqual(1);
    expect(await unreadMessageCount(doctorBSession.userId, scopeDocB)).toBe(0);
    expect(await urgentUnreadMessageCount(doctorBSession.userId, scopeDocB)).toBe(0);
    expect(await urgentUnreadMessageCount(unlinkedDoctorSession.userId, scopeUnlinked)).toBe(0);
  });

  it("handles concurrent race attempts safely while allowing Reception cross-doctor assignment & Doctor new-patient creation", async () => {
    const raceDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

    const [raceVisit1, raceVisit2, raceBook, legitimateReceptionVisit] = await Promise.allSettled([
      addVisit({
        patientName: "سباق 1",
        patientPhone: patientAPhone,
        note: null,
        patientId: patientAId,
        doctorId: doctorBPartyId,
        actorSession: doctorBSession,
      }),
      addVisit({
        patientName: "سباق 2",
        patientPhone: patientAPhone,
        note: null,
        patientId: null,
        doctorId: doctorBPartyId,
        actorSession: doctorBSession,
      }),
      bookAppointment(
        {
          patientId: patientAId,
          date: raceDay,
          time: "12:00",
          durationMinutes: 30,
          doctorId: doctorBPartyId,
        },
        {
          username: doctorBSession.username,
          role: doctorBSession.role,
          doctorPartyId: doctorBPartyId,
          actorSession: doctorBSession,
          channel: "ui",
        },
      ),
      addVisit({
        patientName: "مريض باء محوّل من الاستقبال",
        patientPhone: "772200202",
        note: "تحويل مشروع من الاستقبال",
        patientId: patientBId,
        doctorId: doctorAPartyId,
        actorSession: receptionSession,
      }),
    ]);

    expect(raceVisit1.status).toBe("rejected");
    expect(raceVisit2.status).toBe("rejected");
    expect(raceBook.status).toBe("fulfilled");
    if (raceBook.status === "fulfilled") {
      expect(raceBook.value.ok).toBe(false);
    }
    expect(await canAccessPatient(doctorBSession, patientAId)).toBe(false);

    expect(legitimateReceptionVisit.status).toBe("fulfilled");
    expect(await canAccessPatient(doctorASession, patientBId)).toBe(true);

    const newPatientByDocB = await createPatient(
      {
        fullName: "مريض جديد أنشأه د. باء",
        phone: "773300303",
        altPhone: null,
        gender: "male",
        birthYear: 1988,
        address: null,
        medicalAlert: null,
        note: null,
      },
      { primaryDoctorId: doctorBPartyId },
    );
    const { rows: [primaryRow] } = await getPool().query<{ primary_doctor_id: number | null }>(
      `SELECT primary_doctor_id FROM patients WHERE id = $1`,
      [newPatientByDocB.id],
    );
    expect(primaryRow?.primary_doctor_id).toBe(doctorBPartyId);
    expect(await canAccessPatient(doctorBSession, newPatientByDocB.id)).toBe(true);
    expect(await canAccessPatient(doctorASession, newPatientByDocB.id)).toBe(false);
  });
});
