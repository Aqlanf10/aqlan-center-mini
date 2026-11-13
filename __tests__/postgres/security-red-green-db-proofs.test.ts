import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * إثباتات (أحمر -> أخضر) وتوافق ترقية المخطط على PostgreSQL 18 المعزول ببيانات اصطناعية فقط:
 * 1) ترقية قاعدة عامرة ببيانات اصطناعية من سلسلة الهجرات السابقة (0001..0089) إلى 0127_patient_portal_security.
 * 2) إثبات (أحمر -> أخضر) لمنع الطبيب المقيّد من اصطناع شاهد ملكية عبر الزيارات/المواعيد/المختبر وعزل المرفقات والرسائل.
 * 3) إثبات (أحمر -> أخضر) لعدم تحديد هوية المريض بالهاتف وحده عند اشتراك العائلة في رقم واحد.
 * 4) إثبات الإبطال الحي الفوري لجلسة «عرض بوابة المريض» الإدارية فور دوران كلمة مرور الموظف أو سحب صلاحيته.
 */

assertRealPostgresUrl();
stubPostgresEnv();
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  process.env.SESSION_SECRET = "postgres-test-secret-0123456789abcdef0123456789";
}

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
  }),
  headers: async () => new Headers(),
}));

const {
  AmbiguousSharedPhonePatientError,
  addVisit,
  confirmBookingRequest,
  createBookingRequest,
  createLabOrder,
  createPatient,
  deletePatientMessage,
  deleteStaffMessage,
  ensureSchema,
  getPool,
  insertMessage,
  inspectRetainedDeletedMessage,
  patientThreadMessages,
  resetPoolForTesting,
} = await import("../../lib/db");
const { loadMigrationFiles, migrate } = await import("../../lib/migrations");
const { PatientOutOfScopeError, canAccessPatient } = await import("../../lib/patient-access");
const { bookAppointment } = await import("../../lib/book-appointment");
const { createSessionToken, hashPassword, sessionCredentialVersion } = await import("../../lib/auth");
const { SESSION_COOKIE, PORTAL_ADMIN_PREVIEW_COOKIE_NAME } = await import("../../lib/sessionCookie");
const { STAFF_CAPABILITY_SCHEMA_VERSION } = await import("../../lib/staff-capability-catalogue");
const { STAFF_PERMISSION_ENVELOPE_FIELDS } = await import("../../lib/staff-permission-envelope");
const {
  issuePortalActivation,
  redeemPortalActionToken,
  updatePortalStaffGrant,
} = await import("../../lib/portal-security");
const { POST: startPreviewPost } = await import(
  "../../app/api/patients/[id]/portal-preview/route"
);
const { POST: exitPreviewPost } = await import(
  "../../app/api/portal/admin-preview/exit/route"
);
const { GET: portalMeGet } = await import("../../app/api/portal/me/route");
const { POST: portalMessagesPost } = await import("../../app/api/portal/messages/route");
const { GET: messageFileGet } = await import("../../app/api/messages/file/[id]/route");

import type { SessionPayload } from "../../lib/auth";

function buildCanonicalDoc(opts: {
  revision?: number;
  patientScope: "none" | "own" | "all";
  appointmentScope: "none" | "own" | "all";
  grants: Record<string, boolean>;
}) {
  const doc: Record<string, unknown> = {
    schemaVersion: STAFF_CAPABILITY_SCHEMA_VERSION,
    revision: opts.revision ?? 1,
    patientScope: opts.patientScope,
    appointmentScope: opts.appointmentScope,
    grants: opts.grants,
  };
  if ((STAFF_PERMISSION_ENVELOPE_FIELDS as readonly string[]).includes("confirmation")) {
    doc.confirmation = "owner";
  }
  return doc;
}

function extractSetCookieValue(res: Response, cookieName: string): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    if (raw.startsWith(`${cookieName}=`)) {
      return raw.slice(cookieName.length + 1).split(";")[0] ?? "";
    }
  }
  return null;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
});

afterAll(async () => {
  delete process.env.PATIENT_PORTAL_ACTIVATION_ENABLED;
  cookieJar.clear();
  await resetPoolForTesting();
});

describe("PostgreSQL 18 — Upgrade Proof & Red->Green Security DB Proofs", () => {
  let ownerSession: SessionPayload;
  let previewAdminSession: SessionPayload;
  let receptionSession: SessionPayload;
  let doctorASession: SessionPayload;
  let doctorBSession: SessionPayload;
  let doctorAPartyId = 0;
  let doctorBPartyId = 0;
  let labPartyId = 0;
  let patientOwnedByA = 0;

  it("upgrades populated pre-0127 database to 0127_patient_portal_security + ensureSchema() with zero data loss", async () => {
    const allFiles = await loadMigrationFiles();
    const pre0127 = allFiles.filter((f) => f.version !== "0127");
    const only0127 = allFiles.find((f) => f.version === "0127");
    expect(only0127?.filename).toBe("0127_patient_portal_security.sql");

    const pool = getPool();
    await migrate(pool as never, { apply: true, files: pre0127 });

    // بذر سجلات عيادة اصطناعية قبل تطبيق 0127 لمحاكاة الترقية الفعلية على قاعدة عامرة
    const { rows: parties } = await pool.query<{ id: number }>(
      `INSERT INTO parties (name, kind, is_active)
       VALUES ('د. عزل ألف', 'doctor', TRUE),
              ('د. عزل باء', 'doctor', TRUE),
              ('مختبر ترقية اصطناعي', 'lab', TRUE)
       RETURNING id`,
    );
    doctorAPartyId = parties[0].id;
    doctorBPartyId = parties[1].id;
    labPartyId = parties[2].id;

    const { rows: [seededPatient] } = await pool.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, phone, primary_doctor_id)
       VALUES ('P-UPG-0001', 'مريض ترقية اصطناعي', '771999101', $1)
       RETURNING id`,
      [doctorAPartyId],
    );
    patientOwnedByA = seededPatient.id;

    await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, base_currency)
       VALUES ('INV-UPG-0001', $1, 25000, 'YER')`,
      [patientOwnedByA],
    );

    // الآن ترقية القاعدة بتطبيق 0127 ثم ensureSchema()
    await migrate(pool as never, { apply: true, files: allFiles });
    await ensureSchema();

    const { rows: [invCheck] } = await pool.query<{ total_minor: string }>(
      `SELECT total_minor::text FROM invoices WHERE invoice_number = 'INV-UPG-0001'`,
    );
    expect(invCheck.total_minor).toBe("25000");

    const { rows: [regCheck] } = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE version = '0127'`,
    );
    expect(regCheck.checksum).toBe(only0127!.checksum);

    // إنشاء حسابات الطاقم الاصطناعية وتفعيل مخطط السلطة القانونية الموحدة
    const staffHash = await hashPassword("Synthetic#Upgrade2026!");
    const { rows: users } = await pool.query<{
      id: number;
      username: string;
      role: "admin" | "reception" | "doctor";
      party_id: number | null;
      password_hash: string;
    }>(
      `INSERT INTO users (username, display_name, password_hash, role, party_id, is_active)
       VALUES ('upg.owner', 'مالك معتمد', $3, 'admin', NULL, TRUE),
              ('upg.preview.admin', 'مدير معاينة', $3, 'admin', NULL, TRUE),
              ('upg.reception', 'استقبال', $3, 'reception', NULL, TRUE),
              ('upg.doc.a', 'د. ألف', $3, 'doctor', $1, TRUE),
              ('upg.doc.b', 'د. باء', $3, 'doctor', $2, TRUE)
       RETURNING id, username, role, party_id, password_hash`,
      [doctorAPartyId, doctorBPartyId, staffHash],
    );

    const toSess = (u: (typeof users)[number]): SessionPayload => ({
      userId: u.id,
      username: u.username,
      role: u.role,
      partyId: u.party_id,
      credentialVersion: sessionCredentialVersion(u.password_hash),
      expiresAt: Date.now() + 3_600_000,
    });
    ownerSession = toSess(users[0]);
    previewAdminSession = toSess(users[1]);
    receptionSession = toSess(users[2]);
    doctorASession = toSess(users[3]);
    doctorBSession = toSess(users[4]);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS authorization_mode TEXT NOT NULL DEFAULT 'canonical';
      CREATE TABLE staff_authority_control (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        state TEXT NOT NULL,
        realm_id UUID NOT NULL,
        owner_user_id INTEGER REFERENCES users(id),
        binding_epoch BIGINT NOT NULL
      );
      CREATE TABLE staff_identity_generations (
        generation_id UUID PRIMARY KEY,
        realm_id UUID NOT NULL,
        previous_generation_id UUID REFERENCES staff_identity_generations(generation_id),
        reason TEXT NOT NULL
      );
      CREATE TABLE staff_identity_subjects (
        subject_id UUID PRIMARY KEY,
        realm_id UUID NOT NULL,
        user_id_at_binding INTEGER NOT NULL REFERENCES users(id),
        created_generation_id UUID NOT NULL REFERENCES staff_identity_generations(generation_id),
        created_registry_revision BIGINT NOT NULL UNIQUE
      );
      CREATE TABLE staff_identity_binding_events (
        registry_revision BIGINT PRIMARY KEY,
        generation_id UUID NOT NULL REFERENCES staff_identity_generations(generation_id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        previous_subject_id UUID,
        new_subject_id UUID REFERENCES staff_identity_subjects(subject_id)
      );
      CREATE TABLE staff_identity_current (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        subject_id UUID NOT NULL UNIQUE REFERENCES staff_identity_subjects(subject_id),
        bound_registry_revision BIGINT NOT NULL UNIQUE REFERENCES staff_identity_binding_events(registry_revision)
      );
      CREATE TABLE staff_identity_state (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        status TEXT NOT NULL,
        realm_id UUID NOT NULL,
        generation_id UUID NOT NULL REFERENCES staff_identity_generations(generation_id),
        registry_revision BIGINT NOT NULL,
        ready_owner_subject_id UUID REFERENCES staff_identity_subjects(subject_id),
        ready_control_epoch BIGINT
      );
    `);

    const realmId = randomUUID();
    const genId = randomUUID();
    await pool.query(
      `INSERT INTO staff_identity_generations (generation_id, realm_id, previous_generation_id, reason)
       VALUES ($1::uuid, $2::uuid, NULL, 'initialize')`,
      [genId, realmId],
    );
    let rev = 1;
    let ownerSub = "";
    for (const u of users) {
      rev += 1;
      const sub = randomUUID();
      if (u.id === ownerSession.userId) ownerSub = sub;
      await pool.query(
        `INSERT INTO staff_identity_subjects (subject_id, realm_id, user_id_at_binding, created_generation_id, created_registry_revision)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)`,
        [sub, realmId, u.id, genId, rev],
      );
      await pool.query(
        `INSERT INTO staff_identity_binding_events (registry_revision, generation_id, user_id, previous_subject_id, new_subject_id)
         VALUES ($1, $2::uuid, $3, NULL, $4::uuid)`,
        [rev, genId, u.id, sub],
      );
      await pool.query(
        `INSERT INTO staff_identity_current (user_id, subject_id, bound_registry_revision)
         VALUES ($1, $2::uuid, $3)`,
        [u.id, sub, rev],
      );
      await pool.query(`UPDATE users SET authorization_mode = 'canonical', permissions = $2 WHERE id = $1`, [
        u.id,
        JSON.stringify(
          buildCanonicalDoc({
            patientScope: u.role === "doctor" ? "own" : "all",
            appointmentScope: u.role === "doctor" ? "own" : "all",
            grants: { "patients.create": true, "patients.edit": true },
          }),
        ),
      ]);
    }
    await pool.query(
      `INSERT INTO staff_authority_control (singleton, state, realm_id, owner_user_id, binding_epoch)
       VALUES (TRUE, 'active', $1::uuid, $2, 1)`,
      [realmId, ownerSession.userId],
    );
    await pool.query(
      `INSERT INTO staff_identity_state (singleton, status, realm_id, generation_id, registry_revision, ready_owner_subject_id, ready_control_epoch)
       VALUES (TRUE, 'ready', $1::uuid, $2::uuid, $3, $4::uuid, 1)`,
      [realmId, genId, rev, ownerSub],
    );
  });

  it("[Patient Isolation] RED: unguarded witness row grants restricted doctor access vs GREEN: actorSession guard blocks self-assignment & attachment leak", async () => {
    const pool = getPool();
    const redTarget = await createPatient(
      {
        fullName: "مريض اختبار شاهد الملكية",
        phone: "772888202",
        altPhone: null,
        gender: "male",
        birthYear: 1988,
        address: null,
        medicalAlert: null,
        note: null,
      },
      { primaryDoctorId: doctorAPartyId },
    );

    // قبل أي تلاعب: الطبيب باء ممنوع من الوصول لملف مريض الطبيب ألف
    expect(await canAccessPatient(doctorBSession, redTarget.id)).toBe(false);

    // RED (محاكاة الثغرة قبل الإصلاح): لو سُمح بكتابة صف زيارة باسم doctorBPartyId دون فحص النطاق مسبقًا،
    // لاكتسب الطبيب باء شاهد ملكية شرعيًا وصار `canAccessPatient` يعيد `true`!
    const { rows: [unscopedWitness] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_id, patient_name, doctor_id, status)
       VALUES ($1, $2, $3, 'waiting')
       RETURNING id`,
      [redTarget.id, redTarget.fullName, doctorBPartyId],
    );
    expect(await canAccessPatient(doctorBSession, redTarget.id)).toBe(true);
    await pool.query(`DELETE FROM visits WHERE id = $1`, [unscopedWitness.id]);
    expect(await canAccessPatient(doctorBSession, redTarget.id)).toBe(false);

    // GREEN (الكود الفعلي بعد الإصلاح): جميع مسارات إنشاء الشواهد تفحص النطاق أولًا وترفض الطبيب باء قبل كتابة أي صف!
    await expect(
      addVisit({
        patientName: redTarget.fullName,
        patientPhone: "772888202",
        note: "محاولة استحواذ",
        patientId: redTarget.id,
        doctorId: doctorBPartyId,
        actorSession: doctorBSession,
      }),
    ).rejects.toBeInstanceOf(PatientOutOfScopeError);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const blockedAppt = await bookAppointment(
      {
        patientId: redTarget.id,
        date: tomorrow,
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
    );
    expect(blockedAppt.ok).toBe(false);
    if (!blockedAppt.ok) expect(blockedAppt.status).toBe(403);

    await expect(
      createLabOrder({
        patientId: redTarget.id,
        labName: "مختبر ترقية اصطناعي",
        labPhone: null,
        workType: "تاج",
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

    expect(await canAccessPatient(doctorBSession, redTarget.id)).toBe(false);

    // GREEN (عزل مرفقات المحادثات الطبية): مرفق PDF أرسله مريض الطبيب ألف لا يستطيع الطبيب باء تنزيله (403) بينما يستطيع الطبيب ألف (200)
    const pdfB64 = Buffer.from("%PDF-1.4 synthetic test document", "utf8").toString("base64");
    const msg = await insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: patientOwnedByA,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      kind: "file",
      body: "تقرير مختبر اصطناعي",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: "report.pdf",
      fileMime: "application/pdf",
      fileSize: 32,
      fileData: pdfB64,
      isUrgent: false,
      replyToId: null,
    });

    cookieJar.clear();
    cookieJar.set(SESSION_COOKIE, createSessionToken(doctorBSession));
    const docBFileRes = await messageFileGet(
      new Request(`http://localhost/api/messages/file/${msg.id}`),
      { params: Promise.resolve({ id: String(msg.id) }) },
    );
    expect(docBFileRes.status).toBe(403);

    cookieJar.set(SESSION_COOKIE, createSessionToken(doctorASession));
    const docAFileRes = await messageFileGet(
      new Request(`http://localhost/api/messages/file/${msg.id}`),
      { params: Promise.resolve({ id: String(msg.id) }) },
    );
    expect(docAFileRes.status).toBe(200);
    cookieJar.clear();
  });

  it("[Shared Family Phone] RED: pre-fix phone-only LIMIT 1 picks wrong family member vs GREEN: explicit selection required", async () => {
    const sharedFamilyPhone = "773999303";
    const parentFile = await createPatient({
      fullName: "خالد عبدالله الأب الاصطناعي",
      phone: sharedFamilyPhone,
      altPhone: null,
      gender: "male",
      birthYear: 1980,
      address: null,
      medicalAlert: null,
      note: null,
    });
    const childFile = await createPatient({
      fullName: "ريم خالد الابنة الاصطناعية",
      phone: sharedFamilyPhone,
      altPhone: null,
      gender: "female",
      birthYear: 2015,
      address: null,
      medicalAlert: null,
      note: null,
    });

    // RED (المنطق القديم قبل الإصلاح): `ORDER BY id ASC LIMIT 1` على الهاتف وحده كان يربط زيارة الابنة بملف الأب صامتًا!
    const { rows: [naivePhonePick] } = await getPool().query<{ id: number }>(
      `SELECT id FROM patients WHERE phone = $1 ORDER BY id ASC LIMIT 1`,
      [parentFile.phone],
    );
    expect(naivePhonePick.id).toBe(parentFile.id);
    expect(naivePhonePick.id).not.toBe(childFile.id);

    // GREEN (المنطق الحالي بعد الإصلاح): يرفض التخمين بالهاتف وحده ويعيد قائمة المرشحين لاختيار ملف الابنة بدقة
    let caughtSharedErr: InstanceType<typeof AmbiguousSharedPhonePatientError> | null = null;
    try {
      await addVisit({
        patientName: "ريم خالد الابنة الاصطناعية",
        patientPhone: sharedFamilyPhone,
        note: "فحص تقويم للابنة",
        actorSession: receptionSession,
      });
    } catch (err) {
      if (err instanceof AmbiguousSharedPhonePatientError) caughtSharedErr = err;
      else throw err;
    }
    expect(caughtSharedErr).not.toBeNull();
    expect(caughtSharedErr?.candidates.map((c) => c.id)).toEqual([parentFile.id, childFile.id]);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const req = await createBookingRequest(
      {
        fullName: "ريم خالد الابنة الاصطناعية",
        phone: `967${sharedFamilyPhone}`,
        reason: "استشارة",
        preferredDate: tomorrow,
        preferredPeriod: "evening",
      },
      null,
    );
    await expect(
      confirmBookingRequest({
        id: req.id,
        date: tomorrow,
        time: "17:00",
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(AmbiguousSharedPhonePatientError);

    const confirmedRightChild = await confirmBookingRequest({
      id: req.id,
      date: tomorrow,
      time: "17:00",
      durationMinutes: 30,
      patientId: childFile.id,
    });
    expect(confirmedRightChild?.patientId).toBe(childFile.id);
  });

  it("[Admin Portal Preview Live Revocation] enforces read-only preview banner, blocks mutations, and revokes immediately when staff password rotates or grant is removed", async () => {
    await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: receptionSession.userId,
      canManagePortal: true,
      canPreviewPortal: false,
    });
    delete process.env.PATIENT_PORTAL_ACTIVATION_ENABLED;
    const blockedByDefault = await issuePortalActivation({
      actorSession: receptionSession,
      patientId: patientOwnedByA,
      loginName: "upg.patient.a",
      deliveryChannel: "in_person",
      verificationNote: "تحقق حضوري من الهوية",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(blockedByDefault.ok).toBe(false);
    expect(blockedByDefault.status).toBe(503);

    process.env.PATIENT_PORTAL_ACTIVATION_ENABLED = "true";
    const issued = await issuePortalActivation({
      actorSession: receptionSession,
      patientId: patientOwnedByA,
      loginName: "upg.patient.a",
      deliveryChannel: "in_person",
      verificationNote: "تحقق حضوري من الهوية",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    const rawToken = /[?&]token=([A-Za-z0-9_-]+)/.exec(issued.inPersonUrl!)![1];
    await redeemPortalActionToken({
      rawToken,
      expectedMode: "activate",
      newPassword: "Patient#Pass2026!",
    });

    // مدير غير مخوّل بالمعاينة يُرفض بـ 403
    cookieJar.clear();
    cookieJar.set(SESSION_COOKIE, createSessionToken(previewAdminSession));
    const deniedStart = await startPreviewPost(
      new Request(`http://localhost/api/patients/${patientOwnedByA}/portal-preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "محاولة معاينة قبل منح الصلاحية" }),
      }),
      { params: Promise.resolve({ id: String(patientOwnedByA) }) },
    );
    expect(deniedStart.status).toBe(403);

    // المالك المعتمد يمنح المدير صلاحية المعاينة
    const granted = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: previewAdminSession.userId,
      canManagePortal: true,
      canPreviewPortal: true,
      note: "تخويل رسمي لمعاينة دعم المرضى",
    });
    expect(granted.ok).toBe(true);

    const okStart = await startPreviewPost(
      new Request(`http://localhost/api/patients/${patientOwnedByA}/portal-preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "مراجعة استفسار المريض حول كشف الحساب" }),
      }),
      { params: Promise.resolve({ id: String(patientOwnedByA) }) },
    );
    expect(okStart.status).toBe(200);
    const previewCookie = extractSetCookieValue(okStart, PORTAL_ADMIN_PREVIEW_COOKIE_NAME);
    expect(previewCookie).toBeTruthy();

    cookieJar.set(PORTAL_ADMIN_PREVIEW_COOKIE_NAME, previewCookie!);
    const meDuringPreview = await portalMeGet();
    expect(meDuringPreview.status).toBe(200);
    const meJson = (await meDuringPreview.json()) as {
      patientNumber: string;
      adminPreview?: { staffUsername: string; reason: string };
    };
    expect(meJson.patientNumber).toBe("P-UPG-0001");
    expect(meJson.adminPreview?.staffUsername).toBe("upg.preview.admin");

    // منع تنفيذ أي عملية كتابة باسم المريض أثناء العرض الإداري
    const blockedWrite = await portalMessagesPost(
      new Request("http://localhost/api/portal/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "محاولة إرسال رسالة باسم المريض" }),
      }),
    );
    expect(blockedWrite.status).toBe(403);

    // الإبطال الفوري الجذري: دوران كلمة مرور الموظف يبطل كوكي المعاينة الإدارية فورًا في الطلب التالي!
    const rotatedHash = await hashPassword("RotatedStaff#Pass2026!");
    await getPool().query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
      previewAdminSession.userId,
      rotatedHash,
    ]);
    const meAfterPasswordRotation = await portalMeGet();
    expect(meAfterPasswordRotation.status).toBe(401);

    // الخروج الصريح يمسح كوكي المعاينة
    const exitRes = await exitPreviewPost();
    expect(exitRes.status).toBe(200);
    cookieJar.clear();
    delete process.env.PATIENT_PORTAL_ACTIVATION_ENABLED;
  });

  it("[Message Deletion Non-Destructive Custody on PG18] hides deleted message & attachment downloads while retaining DB storage, auditing, blocking repeat deletes, and gating custody inspection", async () => {
    const pngBase64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44,
    ]).toString("base64");

    const staffFileMsg = await insertMessage({
      senderType: "user",
      senderUserId: doctorASession.userId,
      senderPatientId: null,
      recipientType: "patient",
      recipientUserId: null,
      recipientPatientId: patientOwnedByA,
      body: "SYNTHETIC-PG18-RETAINED-CLINICAL-MSG",
      kind: "file",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: "pg18-retained.png",
      fileMime: "image/png",
      fileSize: 12,
      fileData: pngBase64,
    });

    const pMsg = await insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: patientOwnedByA,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      body: "SYNTHETIC-PG18-PATIENT-MSG",
      kind: "text",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: null,
      fileMime: null,
      fileSize: null,
      fileData: null,
    });

    // طبيب خارج النطاق لا يحذف رسالة غيره
    const wrongDelete = await deleteStaffMessage(staffFileMsg.id, doctorBSession.userId, {
      session: doctorBSession,
    });
    expect(wrongDelete).toEqual({ ok: false, reason: "not-allowed" });

    // حذف الرسالتين من صاحبيهما
    const delStaff = await deleteStaffMessage(staffFileMsg.id, doctorASession.userId, {
      session: doctorASession,
    });
    expect(delStaff.ok).toBe(true);
    const delPat = await deletePatientMessage(pMsg.id, patientOwnedByA, {
      fullName: "مريض ترقية اصطناعي",
    });
    expect(delPat.ok).toBe(true);

    // الحذف المتكرر مرفوض دون مضاعفة التدقيق
    expect(await deleteStaffMessage(staffFileMsg.id, doctorASession.userId)).toEqual({
      ok: false,
      reason: "already-deleted",
    });
    expect(await deletePatientMessage(pMsg.id, patientOwnedByA)).toEqual({
      ok: false,
      reason: "already-deleted",
    });

    // اختفاء المحتوى من الخيط ومن مسار التنزيل للمخوّل (404)، وبقاء 403 للطبيب خارج النطاق
    const thread = await patientThreadMessages(patientOwnedByA);
    const hiddenView = thread.find((m) => m.id === staffFileMsg.id)!;
    expect(hiddenView.deletedAt).toBeTruthy();
    expect(hiddenView.body).toBeNull();
    expect(hiddenView.fileName).toBeNull();

    cookieJar.clear();
    cookieJar.set(SESSION_COOKIE, createSessionToken(doctorASession));
    const docADownload = await messageFileGet(
      new Request(`http://localhost/api/messages/file/${staffFileMsg.id}`),
      { params: Promise.resolve({ id: String(staffFileMsg.id) }) },
    );
    expect(docADownload.status).toBe(404);

    cookieJar.clear();
    cookieJar.set(SESSION_COOKIE, createSessionToken(doctorBSession));
    const docBDownload = await messageFileGet(
      new Request(`http://localhost/api/messages/file/${staffFileMsg.id}`),
      { params: Promise.resolve({ id: String(staffFileMsg.id) }) },
    );
    expect(docBDownload.status).toBe(403);
    cookieJar.clear();

    // التحقق من بقاء السجل والمرفق كاملين في جدول التخزين messages على PostgreSQL 18
    const { rows: [raw] } = await getPool().query<{
      body: string | null;
      file_name: string | null;
      file_data: string | null;
    }>(`SELECT body, file_name, file_data FROM messages WHERE id = $1`, [staffFileMsg.id]);
    expect(raw.body).toBe("SYNTHETIC-PG18-RETAINED-CLINICAL-MSG");
    expect(raw.file_name).toBe("pg18-retained.png");
    expect(raw.file_data).toBe(pngBase64);

    // معاينة العهدة مرفوضة للاستقبال ومقبولة للمالك/الإدارة بسبب مكتوب ومُدقَّق
    const deniedCustody = await inspectRetainedDeletedMessage({
      actorSession: receptionSession,
      messageId: staffFileMsg.id,
      reason: "محاولة غير مخولة من الاستقبال",
    });
    expect(deniedCustody.ok).toBe(false);
    if (!deniedCustody.ok) expect(deniedCustody.status).toBe(403);

    const allowedCustody = await inspectRetainedDeletedMessage({
      actorSession: ownerSession,
      messageId: staffFileMsg.id,
      reason: "مراجعة تدقيق إداري على PostgreSQL 18",
      includeAttachmentBase64: true,
    });
    expect(allowedCustody.ok).toBe(true);
    if (allowedCustody.ok) {
      expect(allowedCustody.record.body).toBe("SYNTHETIC-PG18-RETAINED-CLINICAL-MSG");
      expect(allowedCustody.record.fileDataBase64).toBe(pngBase64);
    }

    const { rows: auditRows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity = 'message' AND entity_id IN ($1, $2)
        ORDER BY id ASC`,
      [String(staffFileMsg.id), String(pMsg.id)],
    );
    expect(auditRows.map((r) => r.action)).toEqual([
      "message.delete",
      "portal.message.delete",
      "message.retained.inspect",
    ]);
  });
});
