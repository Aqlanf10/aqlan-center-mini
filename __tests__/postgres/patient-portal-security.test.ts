import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات تكامل تأمين بوابة المريض على PostgreSQL 18 المعزول ببيانات اصطناعية ومزوّد رسائل وهمي:
 * - التحقق من فشل استنتاج المالك في الوضع القديم (`legacy`) وعدم قبول `MIN(users.id)` أو `isOwner` محليًا.
 * - التحقق من هوية المالك عبر مخطط السلطة القانونية الموحدة (`canonical`) وتقاطع الصلاحيات والإبطال الفوري.
 * - دعم الهاتف العائلي المشترك دون تحديد هوية المريض بالهاتف وحده في البوابة والزيارات وطلبات الحجز.
 * - التفعيل والاستعادة والروابط أحادية الاستخدام وإبطال الجلسات عند تغيير الهاتف أو رقم الملف أو الدمج أو التعطيل.
 * - المعاينة الإدارية للقراءة فقط («عرض بوابة المريض») مع إبطال الجلسة فور تغيّر اعتماد الموظف أو سحب صلاحيته.
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
  createPatient,
  deletePatientCascade,
  ensureSchema,
  getPool,
  mergeDuplicatePatient,
  resetPoolForTesting,
  saveMessagingChannel,
  updatePatient,
} = await import("../../lib/db");
const {
  authenticatePortalAccount,
  getPatientPortalAccountSummary,
  getPortalMigrationReadinessSummary,
  getPortalStaffAccess,
  inspectPortalActionToken,
  issuePortalActivation,
  issuePortalPasswordReset,
  redeemPortalActionToken,
  setPortalAccountStatusByStaff,
  updatePortalStaffGrant,
  verifyLivePortalPatientSession,
} = await import("../../lib/portal-security");
const { readStaffAuthorityMode } = await import("../../lib/staff-owner-authority");
const { STAFF_CAPABILITY_SCHEMA_VERSION } = await import("../../lib/staff-capability-catalogue");
const { STAFF_PERMISSION_ENVELOPE_FIELDS } = await import("../../lib/staff-permission-envelope");
const { hashPassword, sessionCredentialVersion } = await import("../../lib/auth");
const { SESSION_COOKIE } = await import("../../lib/sessionCookie");
const { POST: portalLoginPost } = await import("../../app/api/portal/login/route");
const { POST: portalSettingsPost } = await import("../../app/api/settings/patient-portal/route");
const {
  PORTAL_ADMIN_PREVIEW_DURATION_MS,
  PORTAL_DURATION_MS,
  createPortalAdminPreviewToken,
  createPortalToken,
  isPortalAdminPreview,
  readPortalAdminPreviewToken,
  readPortalToken,
} = await import("../../lib/portal");

import type { SessionPayload } from "../../lib/auth";

let ownerSession: SessionPayload;
let adminNoPreviewSession: SessionPayload;
let adminWithPreviewSession: SessionPayload;
let receptionAuthorizedSession: SessionPayload;
let receptionUngrantedSession: SessionPayload;
let doctorASession: SessionPayload;
let doctorBSession: SessionPayload;

let doctorAPartyId = 0;
let doctorBPartyId = 0;
let patientAId = 0;
let patientANumber = "";
let familySiblingId = 0;
const patientAPhone = "774400401";

function buildCanonicalPermissionDoc(opts: {
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

function extractTokenFromPortalUrl(bodyText: string): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(bodyText);
  if (!match) throw new Error(`لم يُعثر على رمز رابط البوابة في الرسالة الوهمية: ${bodyText}`);
  return decodeURIComponent(match[1]);
}

async function installCanonicalStaffAuthorityOnPublic(
  ownerUserId: number,
  userDocs: Array<{
    userId: number;
    patientScope: "none" | "own" | "all";
    appointmentScope: "none" | "own" | "all";
    grants: Record<string, boolean>;
  }>,
): Promise<void> {
  const pool = getPool();
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS authorization_mode TEXT NOT NULL DEFAULT 'legacy';

    CREATE TABLE IF NOT EXISTS staff_authority_control (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      state TEXT NOT NULL,
      realm_id UUID NOT NULL,
      owner_user_id INTEGER REFERENCES users(id),
      binding_epoch BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_identity_generations (
      generation_id UUID PRIMARY KEY,
      realm_id UUID NOT NULL,
      previous_generation_id UUID REFERENCES staff_identity_generations(generation_id),
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_identity_subjects (
      subject_id UUID PRIMARY KEY,
      realm_id UUID NOT NULL,
      user_id_at_binding INTEGER NOT NULL REFERENCES users(id),
      created_generation_id UUID NOT NULL REFERENCES staff_identity_generations(generation_id),
      created_registry_revision BIGINT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS staff_identity_binding_events (
      registry_revision BIGINT PRIMARY KEY,
      generation_id UUID NOT NULL REFERENCES staff_identity_generations(generation_id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      previous_subject_id UUID,
      new_subject_id UUID REFERENCES staff_identity_subjects(subject_id)
    );

    CREATE TABLE IF NOT EXISTS staff_identity_current (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      subject_id UUID NOT NULL UNIQUE REFERENCES staff_identity_subjects(subject_id),
      bound_registry_revision BIGINT NOT NULL UNIQUE REFERENCES staff_identity_binding_events(registry_revision)
    );

    CREATE TABLE IF NOT EXISTS staff_identity_state (
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
  const generationId = randomUUID();
  await pool.query(
    `INSERT INTO staff_identity_generations (generation_id, realm_id, previous_generation_id, reason)
     VALUES ($1::uuid, $2::uuid, NULL, 'initialize')`,
    [generationId, realmId],
  );

  let revision = 1;
  let ownerSubjectId = "";
  const sorted = [...userDocs].sort((a, b) => a.userId - b.userId);
  for (const item of sorted) {
    revision += 1;
    const subjectId = randomUUID();
    if (item.userId === ownerUserId) ownerSubjectId = subjectId;
    await pool.query(
      `INSERT INTO staff_identity_subjects (subject_id, realm_id, user_id_at_binding, created_generation_id, created_registry_revision)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)`,
      [subjectId, realmId, item.userId, generationId, revision],
    );
    await pool.query(
      `INSERT INTO staff_identity_binding_events (registry_revision, generation_id, user_id, previous_subject_id, new_subject_id)
       VALUES ($1, $2::uuid, $3, NULL, $4::uuid)`,
      [revision, generationId, item.userId, subjectId],
    );
    await pool.query(
      `INSERT INTO staff_identity_current (user_id, subject_id, bound_registry_revision)
       VALUES ($1, $2::uuid, $3)`,
      [item.userId, subjectId, revision],
    );
    await pool.query(
      `UPDATE users
          SET authorization_mode = 'canonical',
              permissions = $2
        WHERE id = $1`,
      [
        item.userId,
        JSON.stringify(
          buildCanonicalPermissionDoc({
            revision: 1,
            patientScope: item.patientScope,
            appointmentScope: item.appointmentScope,
            grants: item.grants,
          }),
        ),
      ],
    );
  }

  await pool.query(
    `INSERT INTO staff_authority_control (singleton, state, realm_id, owner_user_id, binding_epoch)
     VALUES (TRUE, 'active', $1::uuid, $2, 1)`,
    [realmId, ownerUserId],
  );
  await pool.query(
    `INSERT INTO staff_identity_state (singleton, status, realm_id, generation_id, registry_revision, ready_owner_subject_id, ready_control_epoch)
     VALUES (TRUE, 'ready', $1::uuid, $2::uuid, $3, $4::uuid, 1)`,
    [realmId, generationId, revision, ownerSubjectId],
  );
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  const { rows: [reg0127] } = await pool.query<{ version: string; name: string }>(
    `SELECT version, name FROM schema_migrations WHERE version = '0127'`,
  );
  expect(reg0127).toEqual({ version: "0127", name: "patient_portal_security" });

  // التحقق من خلو جدول patient_portal_staff_grants من أي عمود محلي لادعاء الملكية (is_owner)
  const { rows: grantCols } = await pool.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patient_portal_staff_grants'`,
  );
  expect(grantCols.map((c) => c.column_name)).not.toContain("is_owner");

  const { rows: parties } = await pool.query<{ id: number }>(
    `INSERT INTO parties (name, kind, is_active)
     VALUES ('د. بوابة ألف', 'doctor', TRUE),
            ('د. بوابة باء', 'doctor', TRUE)
     RETURNING id`,
  );
  doctorAPartyId = parties[0].id;
  doctorBPartyId = parties[1].id;

  const realHash = await hashPassword("SyntheticStaff#Pass2026!");
  const { rows: users } = await pool.query<{
    id: number;
    username: string;
    role: "admin" | "reception" | "doctor";
    party_id: number | null;
    password_hash: string;
  }>(
    `INSERT INTO users (username, display_name, password_hash, role, party_id, is_active)
     VALUES ('portal.owner', 'المالك العام', $3, 'admin', NULL, TRUE),
            ('portal.admin.plain', 'مدير بلا معاينة', $3, 'admin', NULL, TRUE),
            ('portal.admin.preview', 'مدير مخوّل بالمعاينة', $3, 'admin', NULL, TRUE),
            ('portal.reception.auth', 'استقبال مخوّل بالبوابة', $3, 'reception', NULL, TRUE),
            ('portal.reception.plain', 'استقبال غير مخوّل', $3, 'reception', NULL, TRUE),
            ('portal.doc.a', 'د. ألف', $3, 'doctor', $1, TRUE),
            ('portal.doc.b', 'د. باء', $3, 'doctor', $2, TRUE)
     RETURNING id, username, role, party_id, password_hash`,
    [doctorAPartyId, doctorBPartyId, realHash],
  );

  const toSession = (u: (typeof users)[number]): SessionPayload => ({
    userId: u.id,
    username: u.username,
    role: u.role,
    partyId: u.party_id,
    credentialVersion: sessionCredentialVersion(u.password_hash),
    expiresAt: Date.now() + 3_600_000,
  });

  ownerSession = toSession(users[0]);
  adminNoPreviewSession = toSession(users[1]);
  adminWithPreviewSession = toSession(users[2]);
  receptionAuthorizedSession = toSession(users[3]);
  receptionUngrantedSession = toSession(users[4]);
  doctorASession = toSession(users[5]);
  doctorBSession = toSession(users[6]);

  await saveMessagingChannel({
    channel: "sms",
    enabled: true,
    config: {
      url: "https://mock-sms.aqlan-test.example/v1/send",
      method: "POST",
      bodyFormat: "json",
      toParam: "to",
      textParam: "message",
      senderParam: "sender",
      userParam: "username",
      keyParam: "api_key",
      sender: "AqlanClinic",
      username: "",
      numberFormat: "international",
      successPattern: "",
      inboundKey: "",
    },
    secrets: { apiKey: "synthetic-sms-secret-token" },
    actor: ownerSession.username,
    actorRole: "admin",
  });

  await saveMessagingChannel({
    channel: "whatsapp",
    enabled: true,
    config: {
      provider: "bsp",
      phoneNumberId: "100200300",
      displayNumber: "967770000000",
      graphVersion: "v21.0",
      apiBaseUrl: "https://mock-wa.aqlan-test.example/v1",
      authHeader: "D360-API-KEY",
      verifyToken: "",
      inboundKey: "",
    },
    secrets: { token: "synthetic-wa-secret-token" },
    actor: ownerSession.username,
    actorRole: "admin",
  });

  const patientA = await createPatient(
    {
      fullName: "مريم خالد الاصطناعية",
      phone: patientAPhone,
      altPhone: null,
      gender: "female",
      birthYear: 1995,
      address: "صنعاء",
      medicalAlert: null,
      note: null,
    },
    { primaryDoctorId: doctorAPartyId },
  );
  patientAId = patientA.id;
  patientANumber = patientA.patientNumber;
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("Priority 2 — Patient Portal Security Lifecycle, Authoritative Owner, Shared Phones & Admin Preview", () => {
  it("fails closed in legacy mode: MIN(users.id) is NOT treated as owner, cannot grant preview, and rejects isOwner escalation", async () => {
    const pool = getPool();
    expect(await readStaffAuthorityMode(pool)).toBe("legacy");

    // حتى أول حساب admin (MIN(users.id)) لا يُعتبر مالكًا في الوضع القديم بلا إثبات السلطة القانونية الموحدة
    const legacyFirstAdmin = await getPortalStaffAccess(ownerSession.userId);
    expect(legacyFirstAdmin?.isOwner).toBe(false);
    expect(legacyFirstAdmin?.canPreviewPortal).toBe(false);

    const legacyPreviewGrantAttempt = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: adminWithPreviewSession.userId,
      canManagePortal: true,
      canPreviewPortal: true,
      note: "محاولة منح معاينة في الوضع القديم بلا مالك قانوني",
    });
    expect(legacyPreviewGrantAttempt.ok).toBe(false);
    if (!legacyPreviewGrantAttempt.ok) {
      expect(legacyPreviewGrantAttempt.status).toBe(403);
    }

    // رفض أي محاولة لتمرير حقل isOwner محليًا
    const localOwnerFlagAttempt = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: ownerSession.userId,
      canManagePortal: true,
      canPreviewPortal: false,
      isOwner: true,
    });
    expect(localOwnerFlagAttempt.ok).toBe(false);
    if (!localOwnerFlagAttempt.ok) {
      expect(localOwnerFlagAttempt.status).toBe(403);
    }

    // في الوضع القديم يستطيع المدير منح صلاحية التفعيل/الاستعادة فقط، وتقاطعها مع صلاحيات الطاقم القديمة يعمل
    const legacyManageGrant = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: doctorASession.userId,
      canManagePortal: true,
      canPreviewPortal: false,
      note: "تخويل طبيب في الوضع القديم",
    });
    expect(legacyManageGrant.ok).toBe(true);
    expect((await getPortalStaffAccess(doctorASession.userId))?.canManagePortal).toBe(true);

    // إذا قيّدت صلاحيات الطاقم القديمة تعديل المرضى (canEditPatient=false) تسقط صلاحية إدارة البوابة فورًا
    await pool.query(`UPDATE users SET permissions = $2 WHERE id = $1`, [
      doctorASession.userId,
      JSON.stringify({ canEditPatient: false }),
    ]);
    expect((await getPortalStaffAccess(doctorASession.userId))?.canManagePortal).toBe(false);
    await pool.query(`UPDATE users SET permissions = NULL WHERE id = $1`, [
      doctorASession.userId,
    ]);
  });

  it("proves authoritative owner via canonical staff authority, blocks non-owner escalation, fails closed when held, and intersects unified capabilities", async () => {
    await installCanonicalStaffAuthorityOnPublic(ownerSession.userId, [
      {
        userId: ownerSession.userId,
        patientScope: "all",
        appointmentScope: "all",
        grants: { "patients.create": true, "patients.edit": true, "staff.view": true, "staff.permissions.edit": true },
      },
      {
        userId: adminNoPreviewSession.userId,
        patientScope: "all",
        appointmentScope: "all",
        grants: { "patients.create": true, "patients.edit": true },
      },
      {
        userId: adminWithPreviewSession.userId,
        patientScope: "all",
        appointmentScope: "all",
        grants: { "patients.create": true, "patients.edit": true },
      },
      {
        userId: receptionAuthorizedSession.userId,
        patientScope: "all",
        appointmentScope: "all",
        grants: { "patients.create": true, "patients.edit": true },
      },
      {
        userId: receptionUngrantedSession.userId,
        patientScope: "all",
        appointmentScope: "all",
        grants: { "patients.create": true, "patients.edit": true },
      },
      {
        userId: doctorASession.userId,
        patientScope: "own",
        appointmentScope: "own",
        grants: { "patients.edit": true },
      },
      {
        userId: doctorBSession.userId,
        patientScope: "own",
        appointmentScope: "own",
        grants: { "patients.edit": true },
      },
    ]);

    const pool = getPool();
    expect(await readStaffAuthorityMode(pool)).toBe("canonical");

    const ownerAccess = await getPortalStaffAccess(ownerSession.userId);
    expect(ownerAccess?.isOwner).toBe(true);
    expect(ownerAccess?.canManagePortal).toBe(true);
    expect(ownerAccess?.canPreviewPortal).toBe(true);

    const plainAdminAccess = await getPortalStaffAccess(adminNoPreviewSession.userId);
    expect(plainAdminAccess?.isOwner).toBe(false);
    expect(plainAdminAccess?.canPreviewPortal).toBe(false);

    await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: adminNoPreviewSession.userId,
      canManagePortal: true,
      canPreviewPortal: false,
      note: "إدارة تفعيل فقط دون معاينة",
    });

    const selfEscalateAttempt = await updatePortalStaffGrant({
      actorSession: adminNoPreviewSession,
      targetUserId: adminNoPreviewSession.userId,
      canManagePortal: true,
      canPreviewPortal: true,
      note: "محاولة ترقية ذاتية",
    });
    expect(selfEscalateAttempt.ok).toBe(false);
    if (!selfEscalateAttempt.ok) expect(selfEscalateAttempt.status).toBe(403);

    const receptionPreviewAttempt = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: receptionAuthorizedSession.userId,
      canManagePortal: true,
      canPreviewPortal: true,
    });
    expect(receptionPreviewAttempt.ok).toBe(false);
    if (!receptionPreviewAttempt.ok) expect(receptionPreviewAttempt.status).toBe(400);

    const grantReception = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: receptionAuthorizedSession.userId,
      canManagePortal: true,
      canPreviewPortal: false,
      note: "تخويل الاستقبال بالتفعيل والاستعادة",
    });
    expect(grantReception.ok).toBe(true);

    const grantPreviewAdmin = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: adminWithPreviewSession.userId,
      canManagePortal: true,
      canPreviewPortal: true,
      note: "تخويل الإدارة العليا بمعاينة البوابة للقراءة فقط",
    });
    expect(grantPreviewAdmin.ok).toBe(true);
    expect((await getPortalStaffAccess(adminWithPreviewSession.userId))?.canPreviewPortal).toBe(true);

    // عند تعليق السلطة القانونية (state = 'held') يفشل النظام مغلقًا حتى للمالك نفسه دون تراجع للوضع القديم
    await pool.query(`UPDATE staff_authority_control SET state = 'held' WHERE singleton`);
    const heldOwnerAccess = await getPortalStaffAccess(ownerSession.userId);
    expect(heldOwnerAccess?.isOwner).toBe(false);
    expect(heldOwnerAccess?.canManagePortal).toBe(false);
    expect(heldOwnerAccess?.canPreviewPortal).toBe(false);
    await pool.query(`UPDATE staff_authority_control SET state = 'active' WHERE singleton`);

    // عند سحب نطاق المرضى في وثيقة الصلاحيات الموحدة، تسقط صلاحية المعاينة والتفعيل فورًا
    await pool.query(`UPDATE users SET permissions = $2 WHERE id = $1`, [
      adminWithPreviewSession.userId,
      JSON.stringify(
        buildCanonicalPermissionDoc({
          revision: 2,
          patientScope: "none",
          appointmentScope: "all",
          grants: {},
        }),
      ),
    ]);
    const revokedUnified = await getPortalStaffAccess(adminWithPreviewSession.userId);
    expect(revokedUnified?.canManagePortal).toBe(false);
    expect(revokedUnified?.canPreviewPortal).toBe(false);

    // إعادة وثيقة الصلاحيات الموحدة للمدير المخوّل بالمعاينة
    await pool.query(`UPDATE users SET permissions = $2 WHERE id = $1`, [
      adminWithPreviewSession.userId,
      JSON.stringify(
        buildCanonicalPermissionDoc({
          revision: 3,
          patientScope: "all",
          appointmentScope: "all",
          grants: { "patients.create": true, "patients.edit": true },
        }),
      ),
    ]);
    expect((await getPortalStaffAccess(adminWithPreviewSession.userId))?.canPreviewPortal).toBe(true);
  });

  it("blocks non-admin roles before body parsing on /api/settings/patient-portal and blocks out-of-scope doctors", async () => {
    const { createSessionToken } = await import("../../lib/auth");
    const receptionToken = createSessionToken(receptionAuthorizedSession);
    cookieJar.set(SESSION_COOKIE, receptionToken);
    const badRolePost = await portalSettingsPost(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{malformed-json",
      }),
    );
    cookieJar.clear();
    expect(badRolePost.status).toBe(403);

    const ungrantedAttempt = await issuePortalActivation({
      actorSession: receptionUngrantedSession,
      patientId: patientAId,
      loginName: "mariam.kh",
      deliveryChannel: "sms",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(ungrantedAttempt.ok).toBe(false);
    expect(ungrantedAttempt.status).toBe(403);

    await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: doctorBSession.userId,
      canManagePortal: true,
      canPreviewPortal: false,
    });
    const outOfScopeDocAttempt = await issuePortalActivation({
      actorSession: doctorBSession,
      patientId: patientAId,
      loginName: "mariam.kh",
      deliveryChannel: "sms",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(outOfScopeDocAttempt.ok).toBe(false);
    expect(outOfScopeDocAttempt.status).toBe(403);
  });

  it("activates account via mock SMS, redacts token/URL from logs & DB, enforces atomic single-use under concurrency, and hashes password with scrypt", async () => {
    const capturedBodies: string[] = [];
    const mockSmsFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
      if (parsed.message) capturedBodies.push(parsed.message);
      return new Response(JSON.stringify({ ok: true, id: "mock-sms-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const issued = await issuePortalActivation(
      {
        actorSession: receptionAuthorizedSession,
        patientId: patientAId,
        loginName: "Mariam.Kh",
        deliveryChannel: "sms",
        verificationNote: "تحقق حضوري من البطاقة الشخصية",
        baseOrigin: "https://clinic.aqlan-test.example",
      },
      {
        fetchImpl: mockSmsFetch,
        resolveDns: async () => ["198.51.100.55"],
      },
    );

    expect(issued.ok).toBe(true);
    expect(issued.loginName).toBe("mariam.kh");
    expect(issued.inPersonUrl).toBeUndefined();
    expect(capturedBodies).toHaveLength(1);

    const rawToken = extractTokenFromPortalUrl(capturedBodies[0]);
    expect(rawToken.length).toBeGreaterThanOrEqual(32);

    const pool = getPool();
    const { rows: tokenRows } = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM patient_portal_tokens WHERE patient_id = $1`,
      [patientAId],
    );
    expect(tokenRows[0].token_hash).not.toContain(rawToken);

    const { rows: deliveries } = await pool.query<{ body: string }>(
      `SELECT body FROM message_deliveries WHERE patient_id = $1 ORDER BY id DESC LIMIT 1`,
      [patientAId],
    );
    expect(deliveries[0].body).not.toContain(rawToken);
    expect(deliveries[0].body).not.toContain("token=");

    const { rows: audits } = await pool.query<{ details: unknown; summary: string }>(
      `SELECT details, summary FROM audit_log WHERE entity_id = $1`,
      [String(patientAId)],
    );
    for (const a of audits) {
      expect(JSON.stringify(a.details ?? {})).not.toContain(rawToken);
      expect(a.summary).not.toContain(rawToken);
    }

    const inspected = await inspectPortalActionToken(rawToken);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.loginName).toBe("mariam.kh");
      expect(inspected.mode).toBe("activate");
    }

    const chosenPassword = "Safe#PortalPass2026!";
    const [r1, r2] = await Promise.all([
      redeemPortalActionToken({
        rawToken,
        expectedMode: "activate",
        newPassword: chosenPassword,
      }),
      redeemPortalActionToken({
        rawToken,
        expectedMode: "activate",
        newPassword: chosenPassword,
      }),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (!failures[0].ok) {
      expect(failures[0].status).toBe(410);
      expect(failures[0].code).toBe("token_expired_or_used");
    }

    const { rows: [accRow] } = await pool.query<{ password_hash: string; status: string }>(
      `SELECT password_hash, status FROM patient_portal_accounts WHERE patient_id = $1`,
      [patientAId],
    );
    expect(accRow.status).toBe("active");
    expect(accRow.password_hash.startsWith("scrypt:")).toBe(true);
    expect(accRow.password_hash).not.toContain(chosenPassword);
  });

  it("supports shared family phones without identifying patients by phone alone across Portal, Visits, and Booking Requests", async () => {
    const sibling = await createPatient(
      {
        fullName: "عمر خالد الاصطناعي",
        phone: patientAPhone,
        altPhone: null,
        gender: "male",
        birthYear: 2012,
        address: "صنعاء",
        medicalAlert: null,
        note: "ملف عائلي مشترك الرقم مع والدته/أخته",
      },
      { primaryDoctorId: doctorAPartyId },
    );
    familySiblingId = sibling.id;

    const summary = await getPatientPortalAccountSummary(familySiblingId);
    expect(summary.hasSharedFamilyPhone).toBe(true);
    expect(summary.sharedPhonePatientsCount).toBe(2);

    // البوابة تشترط توثيق التحقق من الهوية والملف المختار عند اشتراك الهاتف العائلي
    const missingNoteActivation = await issuePortalActivation({
      actorSession: receptionAuthorizedSession,
      patientId: familySiblingId,
      loginName: "omar.kh",
      deliveryChannel: "sms",
      verificationNote: "",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(missingNoteActivation.ok).toBe(false);
    expect(missingNoteActivation.code).toBe("shared_phone_verification_required");

    const siblingSmsBodies: string[] = [];
    const siblingActivated = await issuePortalActivation(
      {
        actorSession: receptionAuthorizedSession,
        patientId: familySiblingId,
        loginName: "omar.kh",
        deliveryChannel: "sms",
        verificationNote: "تحقق حضوري من ولي الأمر وتحديد ملف الابن عمر خالد",
        baseOrigin: "https://clinic.aqlan-test.example",
      },
      {
        fetchImpl: (async (_u, init) => {
          siblingSmsBodies.push(JSON.parse(String(init?.body ?? "{}")).message);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch,
        resolveDns: async () => ["198.51.100.55"],
      },
    );
    expect(siblingActivated.ok).toBe(true);
    expect(siblingSmsBodies[0]).toContain(sibling.patientNumber);

    const siblingRawToken = extractTokenFromPortalUrl(siblingSmsBodies[0]);
    const siblingRedeemed = await redeemPortalActionToken({
      rawToken: siblingRawToken,
      expectedMode: "activate",
      newPassword: "Omar#FamilyPass2026!",
    });
    expect(siblingRedeemed.ok).toBe(true);

    // كلا الملفين العائليين يدخلان باستقلالية تامة باسم مستخدم خاص لكل مريض دون خلط الجلسات
    const authMariam = await authenticatePortalAccount("mariam.kh", "Safe#PortalPass2026!");
    const authOmar = await authenticatePortalAccount("omar.kh", "Omar#FamilyPass2026!");
    expect(authMariam?.patientId).toBe(patientAId);
    expect(authOmar?.patientId).toBe(familySiblingId);

    // الزيارات السريعة: الهاتف المشترك لا يختار ملفًا تلقائيًا بل يطلب تحديد الملف أو فتح ملف فرد جديد صراحةً
    await expect(
      addVisit({
        patientName: "مريم خالد الاصطناعية",
        patientPhone: patientAPhone,
        note: "زيارة بهاتف عائلي مشترك بلا تحديد ملف",
        actorSession: receptionAuthorizedSession,
      }),
    ).rejects.toBeInstanceOf(AmbiguousSharedPhonePatientError);

    const selectedVisit = await addVisit({
      patientName: "عمر خالد الاصطناعي",
      patientPhone: patientAPhone,
      patientId: familySiblingId,
      doctorId: doctorAPartyId,
      note: "زيارة محددة الملف صراحةً",
      actorSession: receptionAuthorizedSession,
    });
    expect(selectedVisit.patientId).toBe(familySiblingId);

    // طلبات الحجز العامة: عند تأكيد طلب برقم هاتف عائلي مشترك يجب اختيار الملف أو إنشاء ملف عائلي جديد صراحةً
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const bookingReq = await createBookingRequest(
      {
        fullName: "سليم خالد الاصطناعي",
        phone: `967${patientAPhone}`,
        reason: "فحص أسنان لطفل ثالث في العائلة",
        preferredDate: tomorrow,
        preferredPeriod: "morning",
      },
      null,
    );
    await expect(
      confirmBookingRequest({
        id: bookingReq.id,
        date: tomorrow,
        time: "09:30",
        durationMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(AmbiguousSharedPhonePatientError);

    const confirmedNewMember = await confirmBookingRequest({
      id: bookingReq.id,
      date: tomorrow,
      time: "09:30",
      durationMinutes: 30,
      createNewPatient: true,
    });
    expect(confirmedNewMember).not.toBeNull();

    // حذف ملف الأخ الاصطناعي وعناصره بعد إثبات سيناريو العائلة لإبقاء patientA منفردة لبقية الاختبارات
    const pool = getPool();
    await pool.query(`DELETE FROM visits WHERE patient_id = $1`, [familySiblingId]);
    await deletePatientCascade(familySiblingId, {
      actor: ownerSession.username,
      actorRole: "admin",
      reason: "تنظيف ملف عائلي اصطناعي بعد الاختبار",
    });
    const { rows: thirdMemberRows } = await pool.query<{ id: number }>(
      `SELECT id FROM patients WHERE full_name = 'سليم خالد الاصطناعي'`,
    );
    for (const r of thirdMemberRows) {
      await pool.query(`UPDATE booking_requests SET appointment_id = NULL WHERE appointment_id IN (SELECT id FROM appointments WHERE patient_id = $1)`, [r.id]);
      await pool.query(`DELETE FROM appointments WHERE patient_id = $1`, [r.id]);
      await deletePatientCascade(r.id, {
        actor: ownerSession.username,
        actorRole: "admin",
        reason: "تنظيف ملف عائلي ثالث اصطناعي",
      });
    }
  });

  it("authenticates with username+password, unconditionally blocks legacy phone+file login, and invalidates cookies on file-number edit", async () => {
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ('portal.allow_legacy_phone_login', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`,
    );
    const legacyHttpRes = await portalLoginPost(
      new Request("https://clinic.aqlan-test.example/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: patientAPhone, patientNumber: patientANumber }),
      }),
    );
    expect(legacyHttpRes.status).toBe(403);
    const legacyBody = (await legacyHttpRes.json()) as { code?: string };
    expect(legacyBody.code).toBe("legacy_login_disabled");
    await getPool().query(`DELETE FROM settings WHERE key = 'portal.allow_legacy_phone_login'`);

    const wrongPass = await authenticatePortalAccount("mariam.kh", "Wrong#Pass999!");
    expect(wrongPass).toBeNull();

    const authOk = await authenticatePortalAccount("MARIAM.KH", "Safe#PortalPass2026!");
    expect(authOk).not.toBeNull();
    expect(authOk?.patientId).toBe(patientAId);

    const legacyToken = createPortalToken({
      patientId: patientAId,
      patientNumber: patientANumber,
      fullName: "مريم خالد الاصطناعية",
      expiresAt: Date.now() + PORTAL_DURATION_MS,
    });
    const parsedLegacy = readPortalToken(legacyToken);
    expect(parsedLegacy).not.toBeNull();
    expect(await verifyLivePortalPatientSession(parsedLegacy!)).toBeNull();

    // التحقق من توافق قيد كلاود: تغيّر رقم ملف المريض يبطل جلسة البوابة المصدرة على الرقم القديم
    const liveCookie = readPortalToken(
      createPortalToken({
        patientId: patientAId,
        patientNumber: "OLD-FILE-ALIAS",
        fullName: authOk!.fullName,
        expiresAt: Date.now() + PORTAL_DURATION_MS,
        issuedAt: Date.now(),
        credentialVersion: authOk!.credentialVersion,
        phoneFingerprint: authOk!.phoneFingerprint,
      }),
    )!;
    expect(await verifyLivePortalPatientSession(liveCookie)).toBeNull();
  });

  it("auto-invalidates reset token on outbound provider failure, enforces staff phone verification on WhatsApp reset, and revokes old sessions on password change", async () => {
    const authBefore = await authenticatePortalAccount("mariam.kh", "Safe#PortalPass2026!");
    expect(authBefore).not.toBeNull();
    const activeTokenBefore = createPortalToken({
      patientId: patientAId,
      patientNumber: patientANumber,
      fullName: authBefore!.fullName,
      expiresAt: Date.now() + PORTAL_DURATION_MS,
      issuedAt: Date.now(),
      credentialVersion: authBefore!.credentialVersion,
      phoneFingerprint: authBefore!.phoneFingerprint,
    });
    const parsedBefore = readPortalToken(activeTokenBefore)!;
    expect(await verifyLivePortalPatientSession(parsedBefore)).not.toBeNull();

    const badPhoneReset = await issuePortalPasswordReset({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      deliveryChannel: "whatsapp",
      verifiedPhone: "770000000",
      verificationNote: "اتصال هاتفي",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(badPhoneReset.ok).toBe(false);
    expect(badPhoneReset.code).toBe("phone_mismatch");

    const failingFetch = vi.fn(async () => new Response("gateway down", { status: 500 })) as unknown as typeof fetch;
    const failedReset = await issuePortalPasswordReset(
      {
        actorSession: receptionAuthorizedSession,
        patientId: patientAId,
        deliveryChannel: "whatsapp",
        verifiedPhone: patientAPhone,
        verificationNote: "تحقق من الهوية والرقم المسجل",
        baseOrigin: "https://clinic.aqlan-test.example",
      },
      { fetchImpl: failingFetch, resolveDns: async () => ["198.51.100.60"] },
    );
    expect(failedReset.ok).toBe(false);
    expect(failedReset.status).toBe(502);

    const { rows: [failedTokenRow] } = await getPool().query<{ invalidation_reason: string | null }>(
      `SELECT invalidation_reason FROM patient_portal_tokens WHERE patient_id = $1 ORDER BY id DESC LIMIT 1`,
      [patientAId],
    );
    expect(failedTokenRow.invalidation_reason).toBe("delivery_failed");

    const waBodies: string[] = [];
    const okWaFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { text?: { body?: string } };
      if (payload.text?.body) waBodies.push(payload.text.body);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.mock.1" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const resetIssued = await issuePortalPasswordReset(
      {
        actorSession: receptionAuthorizedSession,
        patientId: patientAId,
        deliveryChannel: "whatsapp",
        verifiedPhone: patientAPhone,
        verificationNote: "تحقق كامل من الهوية والرقم المسجل",
        baseOrigin: "https://clinic.aqlan-test.example",
      },
      { fetchImpl: okWaFetch, resolveDns: async () => ["198.51.100.60"] },
    );
    expect(resetIssued.ok).toBe(true);
    expect(waBodies).toHaveLength(1);

    const resetRawToken = extractTokenFromPortalUrl(waBodies[0]);
    const redeemedReset = await redeemPortalActionToken({
      rawToken: resetRawToken,
      expectedMode: "reset",
      newPassword: "Newer#PortalPass2026!",
    });
    expect(redeemedReset.ok).toBe(true);

    expect(await verifyLivePortalPatientSession(parsedBefore)).toBeNull();
  });

  it("rejects expired links, supports audited in-person verification + contact phone update + single-use link, and revokes both source & target sessions/tokens on merge", async () => {
    const shortNoteAttempt = await issuePortalPasswordReset({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      deliveryChannel: "in_person",
      verificationNote: "قصير",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(shortNoteAttempt.ok).toBe(false);
    expect(shortNoteAttempt.status).toBe(400);

    const expiringIssued = await issuePortalPasswordReset({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      deliveryChannel: "in_person",
      verificationNote: "إصدار رابط مؤقت لاختبار انتهاء الصلاحية",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(expiringIssued.ok).toBe(true);
    const expiredRawToken = extractTokenFromPortalUrl(expiringIssued.inPersonUrl!);
    await getPool().query(
      `UPDATE patient_portal_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE patient_id = $1 AND used_at IS NULL`,
      [patientAId],
    );
    const expiredInspect = await inspectPortalActionToken(expiredRawToken);
    expect(expiredInspect.ok).toBe(false);
    if (!expiredInspect.ok) expect(expiredInspect.status).toBe(410);
    const expiredRedeem = await redeemPortalActionToken({
      rawToken: expiredRawToken,
      expectedMode: "reset",
      newPassword: "Expired#PassAttempt2026!",
    });
    expect(expiredRedeem.ok).toBe(false);
    if (!expiredRedeem.ok) expect(expiredRedeem.status).toBe(410);

    const authPriorToContactUpdate = await authenticatePortalAccount("mariam.kh", "Newer#PortalPass2026!");
    expect(authPriorToContactUpdate).not.toBeNull();
    const sessionPriorToContactUpdate = readPortalToken(
      createPortalToken({
        patientId: patientAId,
        patientNumber: patientANumber,
        fullName: authPriorToContactUpdate!.fullName,
        expiresAt: Date.now() + PORTAL_DURATION_MS,
        issuedAt: Date.now(),
        credentialVersion: authPriorToContactUpdate!.credentialVersion,
        phoneFingerprint: authPriorToContactUpdate!.phoneFingerprint,
      }),
    )!;
    expect(await verifyLivePortalPatientSession(sessionPriorToContactUpdate)).not.toBeNull();

    const inPersonWaCapture: Array<{ to: string; body: string }> = [];
    const inPersonUpdatedPhone = "774499499";
    const inPersonContactUpdateRes = await issuePortalPasswordReset(
      {
        actorSession: receptionAuthorizedSession,
        patientId: patientAId,
        deliveryChannel: "whatsapp",
        inPersonVerified: true,
        updatedPhone: inPersonUpdatedPhone,
        verificationNote: "حضور المريضة شخصيًا ومطابقة الهوية وتحديث رقم التواصل الجديد",
        baseOrigin: "https://clinic.aqlan-test.example",
      },
      {
        fetchImpl: (async (_u, init) => {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            to?: string;
            text?: { body?: string };
          };
          inPersonWaCapture.push({ to: parsed.to ?? "", body: parsed.text?.body ?? "" });
          return new Response(JSON.stringify({ messages: [{ id: "wamid.mock.inperson.1" }] }), {
            status: 200,
          });
        }) as typeof fetch,
        resolveDns: async () => ["198.51.100.60"],
      },
    );
    expect(inPersonContactUpdateRes.ok).toBe(true);
    expect(inPersonWaCapture).toHaveLength(1);
    expect(inPersonWaCapture[0].to).toContain("774499499");
    expect(await verifyLivePortalPatientSession(sessionPriorToContactUpdate)).toBeNull();

    const updatedPhoneToken = extractTokenFromPortalUrl(inPersonWaCapture[0].body);
    const redeemedUpdatedPhone = await redeemPortalActionToken({
      rawToken: updatedPhoneToken,
      expectedMode: "reset",
      newPassword: "UpdatedContact#Pass2026!",
    });
    expect(redeemedUpdatedPhone.ok).toBe(true);
    const replayUpdatedPhone = await redeemPortalActionToken({
      rawToken: updatedPhoneToken,
      expectedMode: "reset",
      newPassword: "ReplayAttempt#Pass2026!",
    });
    expect(replayUpdatedPhone.ok).toBe(false);
    if (!replayUpdatedPhone.ok) expect(replayUpdatedPhone.status).toBe(410);
    await updatePatient(patientAId, { phone: patientAPhone });

    const inPersonIssued = await issuePortalPasswordReset({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      deliveryChannel: "in_person",
      verificationNote: "حضور المريضة شخصيًا ومطابقة البطاقة الشخصية رقم 0101",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(inPersonIssued.ok).toBe(true);
    expect(inPersonIssued.inPersonUrl).toContain("/portal?mode=reset&token=");

    const inPersonToken = extractTokenFromPortalUrl(inPersonIssued.inPersonUrl!);
    const redeemedInPerson = await redeemPortalActionToken({
      rawToken: inPersonToken,
      expectedMode: "reset",
      newPassword: "InPerson#Pass2026!",
    });
    expect(redeemedInPerson.ok).toBe(true);

    const authAfterInPerson = await authenticatePortalAccount("mariam.kh", "InPerson#Pass2026!");
    expect(authAfterInPerson).not.toBeNull();
    const sessionBeforePhoneChange = readPortalToken(
      createPortalToken({
        patientId: patientAId,
        patientNumber: patientANumber,
        fullName: authAfterInPerson!.fullName,
        expiresAt: Date.now() + PORTAL_DURATION_MS,
        issuedAt: Date.now(),
        credentialVersion: authAfterInPerson!.credentialVersion,
        phoneFingerprint: authAfterInPerson!.phoneFingerprint,
      }),
    )!;
    expect(await verifyLivePortalPatientSession(sessionBeforePhoneChange)).not.toBeNull();

    const smsCapture: string[] = [];
    await issuePortalPasswordReset(
      {
        actorSession: receptionAuthorizedSession,
        patientId: patientAId,
        deliveryChannel: "sms",
        verifiedPhone: patientAPhone,
        verificationNote: "تحقق قبل تغيير الهاتف",
        baseOrigin: "https://clinic.aqlan-test.example",
      },
      {
        fetchImpl: (async (_u, init) => {
          smsCapture.push(JSON.parse(String(init?.body ?? "{}")).message);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch,
        resolveDns: async () => ["198.51.100.55"],
      },
    );
    const tokenBeforePhoneChange = extractTokenFromPortalUrl(smsCapture[0]);

    await updatePatient(patientAId, { phone: "775500505" });
    expect(await verifyLivePortalPatientSession(sessionBeforePhoneChange)).toBeNull();
    const redeemAfterPhoneChange = await redeemPortalActionToken({
      rawToken: tokenBeforePhoneChange,
      expectedMode: "reset",
      newPassword: "Blocked#AfterPhoneChange1!",
    });
    expect(redeemAfterPhoneChange.ok).toBe(false);
    if (!redeemAfterPhoneChange.ok) expect(redeemAfterPhoneChange.status).toBe(410);

    const disableRes = await setPortalAccountStatusByStaff({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      action: "disable",
      reason: "إيقاف مؤقت بطلب المريضة",
    });
    expect(disableRes.ok).toBe(true);
    expect(await authenticatePortalAccount("mariam.kh", "InPerson#Pass2026!")).toBeNull();

    await setPortalAccountStatusByStaff({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      action: "enable",
    });
    const targetAuthBeforeMerge = await authenticatePortalAccount("mariam.kh", "InPerson#Pass2026!");
    expect(targetAuthBeforeMerge).not.toBeNull();
    const targetSessionBeforeMerge = readPortalToken(
      createPortalToken({
        patientId: patientAId,
        patientNumber: patientANumber,
        fullName: targetAuthBeforeMerge!.fullName,
        expiresAt: Date.now() + PORTAL_DURATION_MS,
        issuedAt: Date.now(),
        credentialVersion: targetAuthBeforeMerge!.credentialVersion,
        phoneFingerprint: targetAuthBeforeMerge!.phoneFingerprint,
      }),
    )!;
    expect(await verifyLivePortalPatientSession(targetSessionBeforeMerge)).not.toBeNull();

    // إصدار رابط استعادة مفتوح للملف الهدف للتثبت من إبطاله عند دمج ملف آخر فيه
    const openTargetReset = await issuePortalPasswordReset({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      deliveryChannel: "in_person",
      verificationNote: "رابط مفتوح للملف الهدف قبل الدمج",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    const openTargetResetToken = extractTokenFromPortalUrl(openTargetReset.inPersonUrl!);

    const dupPatient = await createPatient({
      fullName: "مريم خالد ملف مكرر",
      phone: "776600606",
      altPhone: null,
      gender: "female",
      birthYear: 1995,
      address: null,
      medicalAlert: null,
      note: null,
    });
    await issuePortalActivation({
      actorSession: receptionAuthorizedSession,
      patientId: dupPatient.id,
      loginName: "mariam.dup",
      deliveryChannel: "in_person",
      verificationNote: "تفعيل تجريبي للملف المكرر قبل الدمج",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    const mergeRes = await mergeDuplicatePatient(dupPatient.id, patientAId, {
      actor: ownerSession.username,
      actorRole: "admin",
      reason: "دمج ملف مكرر في الاختبار",
    });
    expect(mergeRes.ok).toBe(true);
    expect(await authenticatePortalAccount("mariam.dup", "InPerson#Pass2026!")).toBeNull();
    // دمج الملف يدور جلسة الملف الهدف ويبطل روابطه المؤقتة المفتوحة أيضًا
    expect(await verifyLivePortalPatientSession(targetSessionBeforeMerge)).toBeNull();
    const openTargetInspectAfterMerge = await inspectPortalActionToken(openTargetResetToken);
    expect(openTargetInspectAfterMerge.ok).toBe(false);

    const tempDeletePatient = await createPatient({
      fullName: "مريض مؤقت للحذف",
      phone: "778800808",
      altPhone: null,
      gender: "male",
      birthYear: 1991,
      address: null,
      medicalAlert: null,
      note: null,
    });
    await issuePortalActivation({
      actorSession: receptionAuthorizedSession,
      patientId: tempDeletePatient.id,
      loginName: "temp.delete",
      deliveryChannel: "in_person",
      verificationNote: "تفعيل مؤقت لاختبار الحذف المتسلسل",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    const deleted = await deletePatientCascade(tempDeletePatient.id, {
      actor: ownerSession.username,
      actorRole: "admin",
      reason: "حذف مريض تجريبي",
    });
    expect(deleted.ok).toBe(true);

    // فحص مؤشر الجاهزية غير الكاشف للبيانات الشخصية وتنبيه مصدر السجلات التاريخية
    const readiness = await getPortalMigrationReadinessSummary();
    expect(readiness.totalPatients).toBeGreaterThanOrEqual(1);
    expect(readiness.provenanceCaveat).toContain("وحدها لا تثبت");
    expect(JSON.stringify(readiness)).not.toContain("مريم خالد");
    expect(JSON.stringify(readiness)).not.toContain("775500505");
  });

  it("enforces domain-separated read-only administrative preview («عرض بوابة المريض») and carries staffCredentialVersion", () => {
    const startedAt = Date.now();
    const expiresAt = startedAt + PORTAL_ADMIN_PREVIEW_DURATION_MS;
    const previewToken = createPortalAdminPreviewToken({
      patientId: patientAId,
      staffUserId: adminWithPreviewSession.userId,
      staffUsername: adminWithPreviewSession.username,
      staffDisplayName: "مدير مخوّل بالمعاينة",
      staffRole: adminWithPreviewSession.role,
      staffCredentialVersion: adminWithPreviewSession.credentialVersion,
      reason: "مراجعة تطابق كشف الحساب مع ملاحظة المريضة",
      startedAt,
      expiresAt,
    });

    expect(readPortalToken(previewToken)).toBeNull();

    const parsedPreview = readPortalAdminPreviewToken(previewToken);
    expect(parsedPreview).not.toBeNull();
    expect(parsedPreview?.staffUsername).toBe(adminWithPreviewSession.username);
    expect(parsedPreview?.staffCredentialVersion).toBe(adminWithPreviewSession.credentialVersion);
    expect(parsedPreview?.reason).toContain("مراجعة تطابق");

    const regularToken = createPortalToken({
      patientId: patientAId,
      patientNumber: patientANumber,
      fullName: "مريم خالد الاصطناعية",
      expiresAt: Date.now() + PORTAL_DURATION_MS,
      credentialVersion: 1,
    });
    expect(readPortalAdminPreviewToken(regularToken)).toBeNull();
    const regularParsed = readPortalToken(regularToken)!;
    expect(isPortalAdminPreview(regularParsed)).toBe(false);
    expect(
      isPortalAdminPreview({
        ...regularParsed,
        adminPreview: {
          staffUserId: adminWithPreviewSession.userId,
          staffUsername: adminWithPreviewSession.username,
          staffDisplayName: "مدير مخوّل بالمعاينة",
          staffRole: "admin",
          reason: "مراجعة تطابق كشف الحساب",
          startedAt,
          expiresAt,
        },
      }),
    ).toBe(true);
  });
});
