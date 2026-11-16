import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات التكامل الشاملة لبوابة المريض المكتملة (الهجرة 0135) على PostgreSQL 18 ببيانات اصطناعية:
 * 1) فصل صلاحيات المالك والمدير المفوّض بضبط الإعدادات عن صلاحيات التشغيل والمعاينة، وقفل الإنتاج.
 * 2) وضع الاختبار المعزول (`sandbox_test`) ومنع أي اتصال خارجي عبر واتساب/SMS مع روابط المحاكاة.
 * 3) القفل المؤقت للحساب (`423`) وفك القفل، وحرق الرابط المؤقت، وتغيير كلمة المرور ذاتيًا وإبطال الجلسات.
 * 4) عرض الزيارات الموقّعة فقط وخطط العلاج والروشتات الفعّالة والمستندات المسموح بها وعزل الأشعة والملفات الأخرى.
 * 5) منع الكتابة الكامل في «عرض بوابة المريض» الإداري، وسياسات دمج الملفات، وإعلانات المركز، وعهدة الرسائل المحذوفة.
 */

assertRealPostgresUrl();
stubPostgresEnv();
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  process.env.SESSION_SECRET = "postgres-portal-complete-secret-0123456789abcdef012345";
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
  createPatient,
  deletePatientMessage,
  ensureSchema,
  getPool,
  insertMessage,
  mergeDuplicatePatient,
  resetPoolForTesting,
  saveMessagingChannel,
  savePrescription,
} = await import("../../lib/db");
const { putFile } = await import("../../lib/files");
const {
  getPatientPortalAccountSummary,
  getPortalStaffAccess,
  issuePortalActivation,
  issuePortalPasswordReset,
  redeemPortalActionToken,
  setPortalAccountStatusByStaff,
  updatePortalStaffGrant,
  verifyLivePortalPatientSession,
} = await import("../../lib/portal-security");
const { readPortalSettings } = await import("../../lib/portal-settings");
const { STAFF_CAPABILITY_SCHEMA_VERSION } = await import("../../lib/staff-capability-catalogue");
const { STAFF_PERMISSION_ENVELOPE_FIELDS } = await import("../../lib/staff-permission-envelope");
const { createSessionToken, hashPassword, sessionCredentialVersion } = await import("../../lib/auth");
const { SESSION_COOKIE } = await import("../../lib/sessionCookie");
const {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  createPortalAdminPreviewToken,
  readPortalToken,
} = await import("../../lib/portal");

const { GET: bootstrapGet } = await import("../../app/api/portal/bootstrap/route");
const { POST: portalLoginPost } = await import("../../app/api/portal/login/route");
const { GET: portalMeGet } = await import("../../app/api/portal/me/route");
const { GET: portalClinicalGet } = await import("../../app/api/portal/clinical/route");
const { GET: portalPrescriptionsGet } = await import("../../app/api/portal/prescriptions/route");
const { GET: portalDocumentsGet } = await import("../../app/api/portal/documents/route");
const { GET: portalDocumentDownloadGet } = await import(
  "../../app/api/portal/documents/download/route"
);
const { POST: portalChangePasswordPost } = await import(
  "../../app/api/portal/change-password/route"
);
const { POST: portalRevokeSessionsPost } = await import(
  "../../app/api/portal/sessions/revoke/route"
);
const { POST: portalMessagesPost } = await import("../../app/api/portal/messages/route");
const { PATCH: settingsPatch } = await import("../../app/api/settings/patient-portal/route");
const {
  POST: announcementsPost,
  PATCH: announcementsPatch,
} = await import("../../app/api/settings/patient-portal/announcements/route");
const { POST: retainedMessagesPost } = await import(
  "../../app/api/settings/patient-portal/retained-messages/route"
);

import type { SessionPayload } from "../../lib/auth";

let docsDir = "";
let ownerSession: SessionPayload;
let adminDelegatedSession: SessionPayload;
let adminPlainSession: SessionPayload;
let receptionActivationOnlySession: SessionPayload;
let doctorPartyId = 0;
let mainPatientId = 0;
let otherPatientId = 0;

function extractCookieValue(setCookieHeader: string | null, cookieName: string): string | null {
  if (!setCookieHeader) return null;
  const regex = new RegExp(`${cookieName}=([^;]+)`);
  const m = regex.exec(setCookieHeader);
  return m ? decodeURIComponent(m[1]) : null;
}

function extractTokenFromUrl(urlText: string): string {
  const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(urlText);
  if (!m) throw new Error(`لم يُعثر على رمز البوابة في الرابط: ${urlText}`);
  return decodeURIComponent(m[1]);
}

function setStaffCookie(session: SessionPayload) {
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, createSessionToken(session));
}

function setPatientCookie(token: string) {
  cookieJar.clear();
  cookieJar.set(PORTAL_COOKIE, token);
}

async function installCanonicalStaffAuthority(
  ownerUserId: number,
  userDocs: Array<{
    userId: number;
    patientScope: "none" | "own" | "all";
    appointmentScope: "none" | "own" | "all";
    grants: Record<string, boolean>;
  }>,
) {
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
  for (const item of [...userDocs].sort((a, b) => a.userId - b.userId)) {
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
    const doc: Record<string, unknown> = {
      schemaVersion: STAFF_CAPABILITY_SCHEMA_VERSION,
      revision: 1,
      patientScope: item.patientScope,
      appointmentScope: item.appointmentScope,
      grants: item.grants,
    };
    if ((STAFF_PERMISSION_ENVELOPE_FIELDS as readonly string[]).includes("confirmation")) {
      doc.confirmation = "owner";
    }
    await pool.query(
      `UPDATE users SET authorization_mode = 'canonical', permissions = $2 WHERE id = $1`,
      [item.userId, JSON.stringify(doc)],
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
  docsDir = await mkdtemp(join(tmpdir(), "portal-complete-docs-"));
  process.env.DOCUMENTS_DIR = docsDir;
  delete process.env.PATIENT_PORTAL_ACTIVATION_ENABLED;

  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();

  const pool = getPool();
  const { rows: [party] } = await pool.query<{ id: number }>(
    `INSERT INTO parties (name, kind, is_active) VALUES ('د. منصور الاصطناعي', 'doctor', TRUE) RETURNING id`,
  );
  doctorPartyId = party.id;

  const staffHash = await hashPassword("Synthetic#Staff2026!");
  const { rows: users } = await pool.query<{
    id: number;
    username: string;
    role: "admin" | "reception" | "doctor";
    party_id: number | null;
    password_hash: string;
  }>(
    `INSERT INTO users (username, display_name, password_hash, role, party_id, is_active)
     VALUES ('owner.main', 'مالك المركز المعتمد', $1, 'admin', NULL, TRUE),
            ('admin.delegated', 'مدير مفوّض بالإعدادات', $1, 'admin', NULL, TRUE),
            ('admin.plain', 'مدير عادي بلا تفويض بوابة', $1, 'admin', NULL, TRUE),
            ('reception.act', 'موظف استقبال للتفعيل والإعلانات', $1, 'reception', NULL, TRUE)
     RETURNING id, username, role, party_id, password_hash`,
    [staffHash],
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
  adminDelegatedSession = toSession(users[1]);
  adminPlainSession = toSession(users[2]);
  receptionActivationOnlySession = toSession(users[3]);

  await installCanonicalStaffAuthority(ownerSession.userId, [
    {
      userId: ownerSession.userId,
      patientScope: "all",
      appointmentScope: "all",
      grants: {
        "patients.create": true,
        "patients.edit": true,
        "staff.view": true,
        "staff.permissions.edit": true,
      },
    },
    {
      userId: adminDelegatedSession.userId,
      patientScope: "all",
      appointmentScope: "all",
      grants: {
        "patients.create": true,
        "patients.edit": true,
        "staff.view": true,
        "staff.permissions.edit": true,
      },
    },
    {
      userId: adminPlainSession.userId,
      patientScope: "all",
      appointmentScope: "all",
      grants: {
        "patients.create": true,
        "patients.edit": true,
      },
    },
    {
      userId: receptionActivationOnlySession.userId,
      patientScope: "all",
      appointmentScope: "all",
      grants: {
        "patients.create": true,
        "patients.edit": true,
      },
    },
  ]);

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
    secrets: { token: "synthetic-wa-secret" },
    actor: ownerSession.username,
    actorRole: "admin",
  });

  const mainPatient = await createPatient(
    {
      fullName: "سلوى علي الاصطناعية",
      phone: "771234501",
      altPhone: null,
      gender: "female",
      birthYear: 1992,
      address: "صنعاء",
      medicalAlert: "تنبيه سريري داخلي لا يُعرض للمريض",
      note: "ملاحظة استقبال داخلية",
    },
    { primaryDoctorId: doctorPartyId },
  );
  mainPatientId = mainPatient.id;

  const secondPatient = await createPatient({
    fullName: "خالد حسن الاصطناعي",
    phone: "771234502",
    altPhone: null,
    gender: "male",
    birthYear: 1988,
    address: "صنعاء",
    medicalAlert: null,
    note: null,
  });
  otherPatientId = secondPatient.id;
});

afterAll(async () => {
  cookieJar.clear();
  vi.unstubAllEnvs();
  await resetPoolForTesting();
  if (docsDir) await rm(docsDir, { recursive: true, force: true });
});

describe("Patient Portal Complete End-to-End Policies, Clinical Views, Announcements & Custody (0135)", () => {
  it("registers migration 0135 and separates settings-configuration authority from operational/preview authority", async () => {
    const pool = getPool();
    const { rows: [reg0135] } = await pool.query<{ version: string; name: string }>(
      `SELECT version, name FROM schema_migrations WHERE version = '0135'`,
    );
    expect(reg0135).toEqual({
      version: "0135",
      name: "patient_portal_policies_and_announcements",
    });

    const initialSettings = await readPortalSettings();
    expect(initialSettings.operatingMode).toBe("disabled");
    expect(initialSettings.effectiveOperatingMode).toBe("disabled");
    expect(initialSettings.showXrayDocuments).toBe(false);

    // المدير العادي غير المفوّض يُرفض عند محاولة تعديل إعدادات البوابة
    setStaffCookie(adminPlainSession);
    const plainRes = await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatingMode: "sandbox_test" }),
      }),
    );
    expect(plainRes.status).toBe(403);

    // المالك يفوّض المدير المفوّض بصلاحية ضبط الإعدادات فقط دون منحه صلاحية المعاينة أو التشغيل
    const grantRes = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: adminDelegatedSession.userId,
      canConfigurePortalSettings: true,
      canManagePortal: false,
      canPreviewPortal: false,
      note: "تفويض ضبط إعدادات البوابة فقط دون تشغيل أو معاينة",
    });
    expect(grantRes.ok).toBe(true);

    const delegatedAccess = await getPortalStaffAccess(adminDelegatedSession.userId);
    expect(delegatedAccess?.canConfigurePortalSettings).toBe(true);
    expect(delegatedAccess?.canManagePortal).toBe(false);
    expect(delegatedAccess?.canPreviewPortal).toBe(false);

    // المدير المفوّض يستطيع تفعيل وضع الاختبار المعزول وتعديل المدد، لكن لا يستطيع تفعيل الإطلاق الفعلي live_enabled
    setStaffCookie(adminDelegatedSession);
    const liveAttemptByDelegated = await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatingMode: "live_enabled" }),
      }),
    );
    expect(liveAttemptByDelegated.status).toBe(403);

    const sandboxEnableRes = await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatingMode: "sandbox_test",
          maxTokenAttempts: 3,
          maxFailedLoginAttempts: 3,
          accountLockoutMinutes: 15,
        }),
      }),
    );
    expect(sandboxEnableRes.status).toBe(200);

    // حتى المالك المعتمد يُمنع برمجيًا من فتح live_enabled في بيئة الإنتاج قبل فك قفل الإطلاق
    setStaffCookie(ownerSession);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_ALLOW_PRODUCTION_LIVE", "");
    try {
      const prodLockRes = await settingsPatch(
        new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operatingMode: "live_enabled" }),
        }),
      );
      expect(prodLockRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
      process.env.DOCUMENTS_DIR = docsDir;
    }
  });

  it("enforces granular activation vs reset grants and blocks real external WhatsApp/SMS in sandbox_test mode", async () => {
    const recGrant = await updatePortalStaffGrant({
      actorSession: ownerSession,
      targetUserId: receptionActivationOnlySession.userId,
      canManagePortal: false,
      canIssueActivation: true,
      canIssueReset: false,
      canChangeRecoveryPhone: false,
      canPreviewPortal: false,
      canManagePortalAnnouncements: true,
      note: "تفعيل الحسابات وإدارة الإعلانات فقط دون استعادة كلمات المرور",
    });
    expect(recGrant.ok).toBe(true);

    const recAccess = await getPortalStaffAccess(receptionActivationOnlySession.userId);
    expect(recAccess?.canIssueActivation).toBe(true);
    expect(recAccess?.canIssueReset).toBe(false);
    expect(recAccess?.canManagePortalAnnouncements).toBe(true);

    // في وضع الاختبار المعزول: اختيار قناة واتساب لا يجري أي طلب HTTP خارجي ويعيد رابط محاكاة معزول
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const actRes = await issuePortalActivation({
        actorSession: receptionActivationOnlySession,
        patientId: mainPatientId,
        loginName: "salwa.ali",
        deliveryChannel: "whatsapp",
        verificationNote: "تفعيل تجريبي في وضع الاختبار المعزول",
        baseOrigin: "https://clinic.aqlan-test.example",
      });
      expect(actRes.ok).toBe(true);
      if (actRes.ok) {
        expect(actRes.sandboxSimulated).toBe(true);
        expect(actRes.sandboxUrl).toContain("/portal?mode=activate&token=");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("enforces token attempt burn, DB login lockout (423), staff unlock, self-service password change & session revocation", async () => {
    // إصدار رابط تفعيل جديد وحرقه بعد 3 محاولات غير صالحة (maxTokenAttempts = 3)
    const burnIssue = await issuePortalActivation({
      actorSession: receptionActivationOnlySession,
      patientId: mainPatientId,
      loginName: "salwa.ali",
      deliveryChannel: "in_person",
      verificationNote: "اختبار حرق الرابط بعد المحاولات الفاشلة",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(burnIssue.ok).toBe(true);
    const burnToken = extractTokenFromUrl(burnIssue.ok ? burnIssue.inPersonUrl! : "");

    for (let i = 0; i < 2; i++) {
      const badAttempt = await redeemPortalActionToken({
        rawToken: burnToken,
        expectedMode: "activate",
        newPassword: "short",
      });
      expect(badAttempt.ok).toBe(false);
      if (!badAttempt.ok) expect(badAttempt.status).toBe(400);
    }
    const thirdAttempt = await redeemPortalActionToken({
      rawToken: burnToken,
      expectedMode: "activate",
      newPassword: "short",
    });
    expect(thirdAttempt.ok).toBe(false);
    if (!thirdAttempt.ok) expect(thirdAttempt.status).toBe(410);

    // إعادة إصدار رابط صالح وإتمام التفعيل
    const validIssue = await issuePortalActivation({
      actorSession: receptionActivationOnlySession,
      patientId: mainPatientId,
      loginName: "salwa.ali",
      deliveryChannel: "in_person",
      verificationNote: "إعادة إصدار رابط تفعيل صالح",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(validIssue.ok).toBe(true);
    const validToken = extractTokenFromUrl(validIssue.ok ? validIssue.inPersonUrl! : "");
    const redeemed = await redeemPortalActionToken({
      rawToken: validToken,
      expectedMode: "activate",
      newPassword: "Portal#User2026",
    });
    expect(redeemed.ok).toBe(true);

    // الموظف المخوّل بالتفعيل فقط يُرفض عند محاولة إصدار استعادة كلمة مرور (403)
    const unauthorizedReset = await issuePortalPasswordReset({
      actorSession: receptionActivationOnlySession,
      patientId: mainPatientId,
      deliveryChannel: "in_person",
      inPersonVerified: true,
      verificationNote: "محاولة استعادة بدون صلاحية استعادة",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(unauthorizedReset.ok).toBe(false);
    if (!unauthorizedReset.ok) expect(unauthorizedReset.status).toBe(403);

    // 3 محاولات دخول خاطئة تغلق الحساب مؤقتًا برمز 423 حتى مع كلمة المرور الصحيحة
    for (let attempt = 1; attempt <= 3; attempt++) {
      const badLogin = await portalLoginPost(
        new Request("https://clinic.aqlan-test.example/api/portal/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": `198.51.100.${10 + attempt}`,
          },
          body: JSON.stringify({ username: "salwa.ali", password: "WrongPassword99" }),
        }),
      );
      expect(badLogin.status).toBe(attempt === 3 ? 423 : 401);
    }

    const lockedEvenWithRightPass = await portalLoginPost(
      new Request("https://clinic.aqlan-test.example/api/portal/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "198.51.100.55",
        },
        body: JSON.stringify({ username: "salwa.ali", password: "Portal#User2026" }),
      }),
    );
    expect(lockedEvenWithRightPass.status).toBe(423);
    expect((await getPatientPortalAccountSummary(mainPatientId)).isLocked).toBe(true);

    // رفع القفل المؤقت من المالك المعتمد
    const unlocked = await setPortalAccountStatusByStaff({
      actorSession: ownerSession,
      patientId: mainPatientId,
      action: "unlock",
    });
    expect(unlocked.ok).toBe(true);

    const loginOk = await portalLoginPost(
      new Request("https://clinic.aqlan-test.example/api/portal/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "198.51.100.56",
        },
        body: JSON.stringify({ username: "salwa.ali", password: "Portal#User2026" }),
      }),
    );
    expect(loginOk.status).toBe(200);
    const firstSessionCookie = extractCookieValue(
      loginOk.headers.get("set-cookie"),
      PORTAL_COOKIE,
    )!;
    expect(firstSessionCookie).toBeTruthy();

    // تغيير كلمة المرور ذاتيًا من داخل الجلسة النشطة يبطل الكوكي القديم ويمنح كوكي جديدًا صالحًا
    setPatientCookie(firstSessionCookie);
    const wrongCurrentRes = await portalChangePasswordPost(
      new Request("https://clinic.aqlan-test.example/api/portal/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "WrongCurrent123",
          newPassword: "Updated#Pass2027",
        }),
      }),
    );
    expect(wrongCurrentRes.status).toBe(401);

    const changedPassRes = await portalChangePasswordPost(
      new Request("https://clinic.aqlan-test.example/api/portal/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "Portal#User2026",
          newPassword: "Updated#Pass2027",
        }),
      }),
    );
    expect(changedPassRes.status).toBe(200);
    const secondSessionCookie = extractCookieValue(
      changedPassRes.headers.get("set-cookie"),
      PORTAL_COOKIE,
    )!;
    expect(await verifyLivePortalPatientSession(readPortalToken(firstSessionCookie)!)).toBeNull();
    expect(await verifyLivePortalPatientSession(readPortalToken(secondSessionCookie)!)).not.toBeNull();

    // إنهاء جميع الجلسات ذاتيًا
    setPatientCookie(secondSessionCookie);
    const revokeAllRes = await portalRevokeSessionsPost();
    expect(revokeAllRes.status).toBe(200);
    expect(await verifyLivePortalPatientSession(readPortalToken(secondSessionCookie)!)).toBeNull();
  });

  it("exposes only signed visits, active plans, non-void prescriptions, and allowed own documents while blocking admin-preview writes", async () => {
    const pool = getPool();
    const { rows: [svc] } = await pool.query<{ id: number }>(
      `INSERT INTO services (name, category, price_minor, is_active)
       VALUES ('تنظيف وتلميع اصطناعي', 'وقائي', 15000, TRUE)
       RETURNING id`,
    );

    // زيارة موقّعة معتمدة مقابل مسودة سريرية غير موقّعة
    const { rows: [signedVisit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_id, patient_name, doctor_id, status, diagnosis, treatment_done, next_plan, signed_at, signed_by)
       VALUES ($1, 'سلوى علي الاصطناعية', $2, 'done', 'التهاب لثة سطحي اصطناعي', 'تنظيف جير وتلميع كامل', 'مراجعة بعد شهر', NOW(), 'owner.main')
       RETURNING id`,
      [mainPatientId, doctorPartyId],
    );
    await pool.query(
      `INSERT INTO visit_procedures (visit_id, service_id, tooth_code, quantity, unit_price_minor)
       VALUES ($1, $2, 16, 1, 15000)`,
      [signedVisit.id, svc.id],
    );
    await pool.query(
      `INSERT INTO visits (patient_id, patient_name, doctor_id, status, diagnosis, treatment_done)
       VALUES ($1, 'سلوى علي الاصطناعية', $2, 'in_chair', 'مسودة تشخيص داخلية سرية غير موقعة', 'ملاحظة طبيب قيد الكتابة')`,
      [mainPatientId, doctorPartyId],
    );

    // خطة علاج نشطة مقابل خطة ملغاة
    const { rows: [activePlan] } = await pool.query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
       VALUES ($1, 'خطة تقويم وتجميل اصطناعية', 50000, 'YER', 'active', '2026-11-01')
       RETURNING id`,
      [mainPatientId],
    );
    await pool.query(
      `INSERT INTO plan_items (plan_id, service_id, service_name, tooth_code, quantity, unit_price_minor, status)
       VALUES ($1, $2, 'تنظيف وتلميع اصطناعي', 16, 1, 15000, 'done')`,
      [activePlan.id, svc.id],
    );
    await pool.query(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
       VALUES ($1, 'خطة ملغاة لا تعرض', 30000, 'YER', 'cancelled', '2026-10-01')`,
      [mainPatientId],
    );

    // وصفة طبية فعّالة مقابل وصفة مبطلة
    await savePrescription(
      {
        patientId: mainPatientId,
        visitId: signedVisit.id,
        diagnosis: "وقاية بعد التنظيف",
        notes: "بعد الأكل مع الماء",
        instructionsLang: "both",
        prescribingDoctorName: "د. منصور الاصطناعي",
        prescribingDoctorPartyId: doctorPartyId,
        items: [
          {
            name: "Amoxicillin",
            dose: "500mg",
            form: "كبسولات",
            frequency: "كل 8 ساعات",
            duration: "5 أيام",
            instructions: "كبسولة بعد الأكل",
            instructionsEn: "1 capsule after meals",
          },
        ],
      },
      ownerSession.username,
      doctorPartyId,
    );
    const voidedRx = await savePrescription(
      {
        patientId: mainPatientId,
        visitId: signedVisit.id,
        diagnosis: "وصفة مبطلة",
        notes: "",
        instructionsLang: "ar",
        prescribingDoctorName: "د. منصور الاصطناعي",
        prescribingDoctorPartyId: doctorPartyId,
        items: [
          {
            name: "IbuprofenVoided",
            dose: "400mg",
            form: "أقراص",
            frequency: "عند اللزوم",
            duration: "3 أيام",
            instructions: "مبطلة",
            instructionsEn: "",
          },
        ],
      },
      ownerSession.username,
      doctorPartyId,
    );
    await pool.query(
      `UPDATE prescriptions SET status = 'void', voided_at = NOW(), void_reason = 'تصحيح جرعة' WHERE id = $1`,
      [voidedRx.id],
    );

    // مستند تقرير مسموح + صورة أشعة مقيدة + مستند لمريض آخر
    const storedPdf = await putFile(Buffer.from("%PDF-1.4 synthetic report"), "pdf");
    const storedXray = await putFile(Buffer.from("\x89PNG\r\n\x1a\nsynthetic-xray"), "png");

    const { rows: [reportDoc] } = await pool.query<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, storage_key, sha256, mime_type, size_bytes, uploaded_by)
       VALUES ($1, 'report', 'تقرير متابعة اصطناعي', $2, $3, 'application/pdf', $4, 'owner.main')
       RETURNING id`,
      [mainPatientId, storedPdf.key, storedPdf.sha256, storedPdf.sizeBytes],
    );
    const { rows: [xrayDoc] } = await pool.query<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, storage_key, sha256, mime_type, size_bytes, uploaded_by)
       VALUES ($1, 'xray', 'أشعة بانوراما اصطناعية', $2, $3, 'image/png', $4, 'owner.main')
       RETURNING id`,
      [mainPatientId, storedXray.key, storedXray.sha256, storedXray.sizeBytes],
    );
    const { rows: [foreignDoc] } = await pool.query<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, storage_key, sha256, mime_type, size_bytes, uploaded_by)
       VALUES ($1, 'report', 'تقرير مريض آخر سري', $2, $3, 'application/pdf', $4, 'owner.main')
       RETURNING id`,
      [otherPatientId, storedPdf.key, storedPdf.sha256, storedPdf.sizeBytes],
    );

    // تسجيل دخول المريضة بعد التحديث الأخير لكلمة المرور
    const loginRes = await portalLoginPost(
      new Request("https://clinic.aqlan-test.example/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.88" },
        body: JSON.stringify({ username: "salwa.ali", password: "Updated#Pass2027" }),
      }),
    );
    expect(loginRes.status).toBe(200);
    const activeCookie = extractCookieValue(loginRes.headers.get("set-cookie"), PORTAL_COOKIE)!;
    setPatientCookie(activeCookie);

    const meRes = await portalMeGet();
    const meJson = await meRes.json();
    expect(meRes.status).toBe(200);
    expect(meJson.profile.maskedPhone).toBe("+967 ••• ••• 501");
    expect(JSON.stringify(meJson)).not.toContain("771234501");
    expect(JSON.stringify(meJson)).not.toContain("تنبيه سريري داخلي");
    expect(JSON.stringify(meJson)).not.toContain("ملاحظة استقبال داخلية");

    const clinicalRes = await portalClinicalGet();
    const clinicalJson = await clinicalRes.json();
    expect(clinicalRes.status).toBe(200);
    expect(clinicalJson.visits).toHaveLength(1);
    expect(clinicalJson.visits[0].diagnosis).toBe("التهاب لثة سطحي اصطناعي");
    expect(JSON.stringify(clinicalJson)).not.toContain("مسودة تشخيص داخلية سرية");
    expect(clinicalJson.plans).toHaveLength(1);
    expect(clinicalJson.plans[0].title).toBe("خطة تقويم وتجميل اصطناعية");

    const rxRes = await portalPrescriptionsGet();
    const rxJson = await rxRes.json();
    expect(rxRes.status).toBe(200);
    expect(rxJson.prescriptions).toHaveLength(1);
    expect(rxJson.prescriptions[0].items[0].drug).toBe("Amoxicillin");
    expect(JSON.stringify(rxJson)).not.toContain("IbuprofenVoided");

    const docsRes = await portalDocumentsGet();
    const docsJson = await docsRes.json();
    expect(docsRes.status).toBe(200);
    expect(docsJson.documents.map((d: { id: number }) => d.id)).toEqual([reportDoc.id]);

    const dlReport = await portalDocumentDownloadGet(
      new Request(
        `https://clinic.aqlan-test.example/api/portal/documents/download?id=${reportDoc.id}`,
      ),
    );
    expect(dlReport.status).toBe(200);
    expect(dlReport.headers.get("x-content-type-options")).toBe("nosniff");

    const dlXrayBlocked = await portalDocumentDownloadGet(
      new Request(
        `https://clinic.aqlan-test.example/api/portal/documents/download?id=${xrayDoc.id}`,
      ),
    );
    expect(dlXrayBlocked.status).toBe(403);

    const dlForeign = await portalDocumentDownloadGet(
      new Request(
        `https://clinic.aqlan-test.example/api/portal/documents/download?id=${foreignDoc.id}`,
      ),
    );
    expect(dlForeign.status).toBe(404);

    // تفعيل عرض الأشعة وإيقاف الزيارات والروشتات والمرفقات الصوتية/الملفات عبر الإعدادات والتأكد من تطبيقها على الـ API
    setStaffCookie(ownerSession);
    await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showXrayDocuments: true,
          showVisits: false,
          showTreatmentPlans: false,
          showPrescriptions: false,
          allowVoiceMessages: false,
          allowMessageAttachments: false,
        }),
      }),
    );

    setPatientCookie(activeCookie);
    const dlXrayAllowed = await portalDocumentDownloadGet(
      new Request(
        `https://clinic.aqlan-test.example/api/portal/documents/download?id=${xrayDoc.id}`,
      ),
    );
    expect(dlXrayAllowed.status).toBe(200);
    expect((await portalClinicalGet()).status).toBe(403);
    expect((await portalPrescriptionsGet()).status).toBe(403);

    const voiceBlockedRes = await portalMessagesPost(
      new Request("https://clinic.aqlan-test.example/api/portal/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "voice",
          voiceMime: "audio/webm",
          voiceData: Buffer.from("voice").toString("base64"),
          voiceMs: 2000,
        }),
      }),
    );
    expect(voiceBlockedRes.status).toBe(403);

    // إعادة مفاتيح الأقسام للوضع الافتراضي وفحص حظر الكتابة الصارم في العرض الإداري
    setStaffCookie(ownerSession);
    await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showXrayDocuments: false,
          showVisits: true,
          showTreatmentPlans: true,
          showPrescriptions: true,
          allowVoiceMessages: true,
          allowMessageAttachments: true,
        }),
      }),
    );

    const previewToken = createPortalAdminPreviewToken({
      patientId: mainPatientId,
      staffUserId: ownerSession.userId,
      staffUsername: ownerSession.username,
      staffDisplayName: "مالك المركز المعتمد",
      staffRole: "admin",
      staffCredentialVersion: ownerSession.credentialVersion,
      reason: "فحص تطابق السجلات المعروضة للمريض في العرض الإداري",
      startedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });
    setStaffCookie(ownerSession);
    cookieJar.set(PORTAL_ADMIN_PREVIEW_COOKIE, previewToken);

    expect((await portalMeGet()).status).toBe(200);
    expect(
      (
        await portalChangePasswordPost(
          new Request("https://clinic.aqlan-test.example/api/portal/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentPassword: "Updated#Pass2027",
              newPassword: "ShouldFail#2028",
            }),
          }),
        )
      ).status,
    ).toBe(403);
    expect((await portalRevokeSessionsPost()).status).toBe(403);
  });

  it("enforces configurable post-merge target account policies (keep_target_revoke_sessions & suspend_on_conflict_or_dual)", async () => {
    setStaffCookie(ownerSession);
    await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postMergeTargetPolicy: "keep_target_revoke_sessions" }),
      }),
    );

    const loginBeforeMerge = await portalLoginPost(
      new Request("https://clinic.aqlan-test.example/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.90" },
        body: JSON.stringify({ username: "salwa.ali", password: "Updated#Pass2027" }),
      }),
    );
    const preMergeCookie = extractCookieValue(
      loginBeforeMerge.headers.get("set-cookie"),
      PORTAL_COOKIE,
    )!;

    const dupNoAccount = await createPatient({
      fullName: "سلوى علي مكرر بلا بوابة",
      phone: "771234501",
      altPhone: null,
      gender: "female",
      birthYear: 1992,
      address: null,
      medicalAlert: null,
      note: null,
    });
    const mergeKeep = await mergeDuplicatePatient(dupNoAccount.id, mainPatientId, {
      actor: ownerSession.username,
      actorRole: "admin",
      reason: "دمج ملف مكرر بلا حساب بوابة مع الإبقاء على حساب الهدف وإبطال جلساته",
    });
    expect(mergeKeep.ok).toBe(true);
    expect((await getPatientPortalAccountSummary(mainPatientId)).status).toBe("active");
    expect(await verifyLivePortalPatientSession(readPortalToken(preMergeCookie)!)).toBeNull();

    // الآن اختبار suspend_on_conflict_or_dual عند دمج ملفين كلاهما يملكان حساب بوابة
    await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postMergeTargetPolicy: "suspend_on_conflict_or_dual" }),
      }),
    );

    const dupWithAccount = await createPatient({
      fullName: "سلوى علي مكرر بحساب بوابة",
      phone: "771234599",
      altPhone: null,
      gender: "female",
      birthYear: 1992,
      address: null,
      medicalAlert: null,
      note: null,
    });
    await issuePortalActivation({
      actorSession: receptionActivationOnlySession,
      patientId: dupWithAccount.id,
      loginName: "salwa.dup2",
      deliveryChannel: "in_person",
      verificationNote: "تفعيل للملف المكرر الثاني لاختبار التعارض",
      baseOrigin: "https://clinic.aqlan-test.example",
    });

    const mergeDual = await mergeDuplicatePatient(dupWithAccount.id, mainPatientId, {
      actor: ownerSession.username,
      actorRole: "admin",
      reason: "دمج ملفين يملكان حسابي بوابة في وضع suspend_on_conflict_or_dual",
    });
    expect(mergeDual.ok).toBe(true);
    const summaryAfterDualMerge = await getPatientPortalAccountSummary(mainPatientId);
    expect(summaryAfterDualMerge.status).toBe("disabled");
    expect(summaryAfterDualMerge.disabledReason).toBe("patient_merged_pending_identity_review");
  });

  it("manages Center Announcements (CRUD, reorder, schedule, sample exclusion) and audits retained deleted-message custody", async () => {
    setStaffCookie(receptionActivationOnlySession);

    const createAnn1 = await announcementsPost(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleAr: "أوقات دوام المركز الرسمية",
          bodyAr: "نستقبلكم من السبت إلى الخميس من 9 صباحًا حتى 9 مساءً.",
          tone: "sky",
          isActive: true,
          isSample: false,
        }),
      }),
    );
    expect(createAnn1.status).toBe(201);
    const ann1Json = await createAnn1.json();
    const ann1Id = ann1Json.item.id as number;

    const createSampleAnn = await announcementsPost(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleAr: "إعلان تجريبي للفحص فقط",
          bodyAr: "هذا نموذج تجريبي لا يظهر عند الإطلاق الفعلي.",
          badgeLabel: "نموذج تجريبي — غير منشور",
          tone: "amber",
          isActive: true,
          isSample: true,
        }),
      }),
    );
    expect(createSampleAnn.status).toBe(201);
    const sampleAnnId = (await createSampleAnn.json()).item.id as number;

    // إعلان مجدول للمستقبل البعيد لا يظهر في bootstrap الآن
    const createFutureAnn = await announcementsPost(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleAr: "إعلان مستقبلي غير حان وقته",
          bodyAr: "يبدأ العرض في العام القادم.",
          tone: "navy",
          isActive: true,
          isSample: false,
          startsAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
        }),
      }),
    );
    expect(createFutureAnn.status).toBe(201);
    const futureAnnId = (await createFutureAnn.json()).item.id as number;

    // إعادة الترتيب بحيث يتصدر الإعلان التجريبي في وضع sandbox_test
    const reorderRes = await announcementsPost(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reorder",
          orderedIds: [sampleAnnId, ann1Id, futureAnnId],
        }),
      }),
    );
    expect(reorderRes.status).toBe(200);

    const bootstrapSandbox = await (await bootstrapGet()).json();
    expect(
      bootstrapSandbox.announcements.map((a: { id: number }) => a.id),
    ).toEqual([sampleAnnId, ann1Id]);

    // عند تحويل المالك لوضع live_enabled (في بيئة الاختبار غير الإنتاجية) يختفي النموذج التجريبي تلقائيًا
    setStaffCookie(ownerSession);
    await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatingMode: "live_enabled" }),
      }),
    );
    const bootstrapLive = await (await bootstrapGet()).json();
    expect(bootstrapLive.announcements.map((a: { id: number }) => a.id)).toEqual([ann1Id]);

    // إعادة الوضع إلى sandbox_test وتعديل الإعلان
    await settingsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatingMode: "sandbox_test" }),
      }),
    );
    setStaffCookie(receptionActivationOnlySession);
    const patchAnn = await announcementsPatch(
      new Request("https://clinic.aqlan-test.example/api/settings/patient-portal/announcements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ann1Id, badgeLabel: "دوام المركز" }),
      }),
    );
    expect(patchAnn.status).toBe(200);

    // فحص مسار عهدة الرسائل المحذوفة المدقّقة
    const msg = await insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: mainPatientId,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      kind: "text",
      body: "رسالة اصطناعية تُحذف من الواجهة وتبقى في العهدة الآمنة",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: null,
      fileMime: null,
      fileSize: null,
      fileData: null,
    });
    const delRes = await deletePatientMessage(mainPatientId, msg.id);
    expect(delRes.ok).toBe(true);

    // موظف الاستقبال يُرفض (403)
    const recInspect = await retainedMessagesPost(
      new Request(
        "https://clinic.aqlan-test.example/api/settings/patient-portal/retained-messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: msg.id,
            reason: "محاولة معاينة من الاستقبال",
          }),
        },
      ),
    );
    expect(recInspect.status).toBe(403);

    // المدير المالك بدون سبب كافٍ يُرفض (400)، وبسبب مكتوب يُقبل ويسجّل التدقيق
    setStaffCookie(ownerSession);
    const shortReasonInspect = await retainedMessagesPost(
      new Request(
        "https://clinic.aqlan-test.example/api/settings/patient-portal/retained-messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: msg.id, reason: "قصير" }),
        },
      ),
    );
    expect(shortReasonInspect.status).toBe(400);

    const validInspect = await retainedMessagesPost(
      new Request(
        "https://clinic.aqlan-test.example/api/settings/patient-portal/retained-messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: msg.id,
            reason: "مراجعة تدقيق أمني للرسالة المحذوفة في الاختبار",
          }),
        },
      ),
    );
    expect(validInspect.status).toBe(200);
    const validInspectJson = await validInspect.json();
    expect(validInspectJson.record.body).toContain("تبقى في العهدة الآمنة");

    const { rows: auditRows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action IN ('portal.settings.update', 'portal.announcement.create', 'message.retained.inspect')`,
    );
    const actions = new Set(auditRows.map((r) => r.action));
    expect(actions.has("portal.settings.update")).toBe(true);
    expect(actions.has("portal.announcement.create")).toBe(true);
    expect(actions.has("message.retained.inspect")).toBe(true);
  });
});
