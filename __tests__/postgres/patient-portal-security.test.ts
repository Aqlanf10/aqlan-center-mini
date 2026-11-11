import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات تكامل تأمين بوابة المريض على PostgreSQL 18 المعزول ببيانات اصطناعية ومزوّد رسائل وهمي.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
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
  getPortalStaffAccess,
  inspectPortalActionToken,
  issuePortalActivation,
  issuePortalPasswordReset,
  redeemPortalActionToken,
  setPortalAccountStatusByStaff,
  updatePortalStaffGrant,
  verifyLivePortalPatientSession,
} = await import("../../lib/portal-security");
const { POST: portalLoginPost } = await import("../../app/api/portal/login/route");
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
let doctorBSession: SessionPayload;

let doctorAPartyId = 0;
let doctorBPartyId = 0;
let patientAId = 0;
let patientANumber = "";
const patientAPhone = "774400401";

function extractTokenFromPortalUrl(bodyText: string): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(bodyText);
  if (!match) throw new Error(`لم يُعثر على رمز رابط البوابة في الرسالة الوهمية: ${bodyText}`);
  return decodeURIComponent(match[1]);
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  const { rows: [reg0127] } = await pool.query<{ version: string; name: string }>(
    `SELECT version, name FROM schema_migrations WHERE version = '0127'`,
  );
  expect(reg0127).toEqual({ version: "0127", name: "patient_portal_security" });

  const { rows: parties } = await pool.query<{ id: number }>(
    `INSERT INTO parties (name, kind, is_active)
     VALUES ('د. بوابة ألف', 'doctor', TRUE),
            ('د. بوابة باء', 'doctor', TRUE)
     RETURNING id`,
  );
  doctorAPartyId = parties[0].id;
  doctorBPartyId = parties[1].id;

  const { rows: users } = await pool.query<{
    id: number;
    username: string;
    role: "admin" | "reception" | "doctor";
    party_id: number | null;
  }>(
    `INSERT INTO users (username, display_name, password_hash, role, party_id, is_active)
     VALUES ('portal.owner', 'المالك العام', 'scrypt:dummy', 'admin', NULL, TRUE),
            ('portal.admin.plain', 'مدير بلا معاينة', 'scrypt:dummy', 'admin', NULL, TRUE),
            ('portal.admin.preview', 'مدير مخوّل بالمعاينة', 'scrypt:dummy', 'admin', NULL, TRUE),
            ('portal.reception.auth', 'استقبال مخوّل بالبوابة', 'scrypt:dummy', 'reception', NULL, TRUE),
            ('portal.reception.plain', 'استقبال غير مخوّل', 'scrypt:dummy', 'reception', NULL, TRUE),
            ('portal.doc.a', 'د. ألف', 'scrypt:dummy', 'doctor', $1, TRUE),
            ('portal.doc.b', 'د. باء', 'scrypt:dummy', 'doctor', $2, TRUE)
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
  adminNoPreviewSession = toSession(users[1]);
  adminWithPreviewSession = toSession(users[2]);
  receptionAuthorizedSession = toSession(users[3]);
  receptionUngrantedSession = toSession(users[4]);
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

describe("Priority 2 — Patient Portal Security Lifecycle, Mock Messaging & Admin Preview", () => {
  it("enforces staff grant boundaries: non-owner admin cannot self-grant preview, owner grants manage & preview independently", async () => {
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
  });

  it("blocks unauthorized staff & out-of-scope doctors from activating portal accounts", async () => {
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

  it("authenticates with username+password, unconditionally blocks legacy phone+file login with zero emergency bypass, and rejects legacy cookies lacking credentialVersion", async () => {
    // حتى لو وُجد مفتاح قديم في settings، مسار الدخول القديم محذوف نهائيًا ولا يفتح أبداً
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

  it("rejects expired links, supports audited in-person verification + contact phone update + single-use temporary link, and revokes sessions/tokens on phone change, disable, merge, and delete", async () => {
    const shortNoteAttempt = await issuePortalPasswordReset({
      actorSession: receptionAuthorizedSession,
      patientId: patientAId,
      deliveryChannel: "in_person",
      verificationNote: "قصير",
      baseOrigin: "https://clinic.aqlan-test.example",
    });
    expect(shortNoteAttempt.ok).toBe(false);
    expect(shortNoteAttempt.status).toBe(400);

    // اختبار انتهاء صلاحية الرابط المؤقت (410)
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

    // اختبار التحقق الحضوري مع تحديث وسيلة التواصل (عند فقدان الرقم القديم) وإرسال رابط مؤقت أحادي الاستخدام للرقم الجديد
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
    // تحديث الهاتف يبطل الجلسة القديمة فورًا حتى قبل استخدام رابط الاستعادة
    expect(await verifyLivePortalPatientSession(sessionPriorToContactUpdate)).toBeNull();

    const updatedPhoneToken = extractTokenFromPortalUrl(inPersonWaCapture[0].body);
    const redeemedUpdatedPhone = await redeemPortalActionToken({
      rawToken: updatedPhoneToken,
      expectedMode: "reset",
      newPassword: "UpdatedContact#Pass2026!",
    });
    expect(redeemedUpdatedPhone.ok).toBe(true);
    // منع إعادة استخدام نفس الرابط المؤقت مرة ثانية
    const replayUpdatedPhone = await redeemPortalActionToken({
      rawToken: updatedPhoneToken,
      expectedMode: "reset",
      newPassword: "ReplayAttempt#Pass2026!",
    });
    expect(replayUpdatedPhone.ok).toBe(false);
    if (!replayUpdatedPhone.ok) expect(replayUpdatedPhone.status).toBe(410);
    // إرجاع الرقم الأصلي لاستكمال بقية السيناريوهات
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

    const freshAuth = await authenticatePortalAccount("mariam.kh", "InPerson#Pass2026!");
    expect(freshAuth).not.toBeNull();
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
    expect(await authenticatePortalAccount("mariam.kh", "InPerson#Pass2026!")).not.toBeNull();

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
  });

  it("enforces domain-separated read-only administrative preview («عرض بوابة المريض») with staff identity & reason", () => {
    const startedAt = Date.now();
    const expiresAt = startedAt + PORTAL_ADMIN_PREVIEW_DURATION_MS;
    const previewToken = createPortalAdminPreviewToken({
      patientId: patientAId,
      staffUserId: adminWithPreviewSession.userId,
      staffUsername: adminWithPreviewSession.username,
      staffDisplayName: "مدير مخوّل بالمعاينة",
      staffRole: adminWithPreviewSession.role,
      reason: "مراجعة تطابق كشف الحساب مع ملاحظة المريضة",
      startedAt,
      expiresAt,
    });

    expect(readPortalToken(previewToken)).toBeNull();

    const parsedPreview = readPortalAdminPreviewToken(previewToken);
    expect(parsedPreview).not.toBeNull();
    expect(parsedPreview?.staffUsername).toBe(adminWithPreviewSession.username);
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
