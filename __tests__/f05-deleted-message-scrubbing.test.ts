import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * إثبات الحذف الآمن للرسائل مع الاحتفاظ غير المدمّر في التخزين (المتطلب 1 — 2026-11-14):
 *  1) تختفي الرسالة المحذوفة (نصها واسم ملفها واقتباساتها) من واجهة المستخدم وقوائم المحادثات،
 *     وتُحجب روابط تنزيل المرفق والصوت (`/api/messages/file/[id]` و`/api/messages/voice/[id]`) بـ 404 للمخوّلين،
 *     مع بقاء 403 لغير المخوّلين (دون تسريب حالة الحذف).
 *  2) لا يُمحى النص أو الصوت أو المرفق من التخزين (`messages`) تلقائيًا قبل اعتماد سياسة الاحتفاظ.
 *  3) يُسجَّل الحذف في `audit_log` داخل المعاملة نفسها (`message.delete` و`portal.message.delete`).
 *  4) الحذف المتكرر يُرفض (`already-deleted` / HTTP 409) دون تغيير ختم `deleted_at` أو تكرار سطر التدقيق.
 *  5) معاينة السجل المحذوف المحتفظ به (`inspectRetainedDeletedMessage`) محصورة بالإدارة النشطة ذات النطاق الكامل
 *     وبسبب مكتوب إلزامي مع تسجيل `message.retained.inspect` في `audit_log`.
 */

const sessionMocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireSessionStrict: vi.fn(),
  requirePortalSession: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: sessionMocks.requireSession,
  requireSessionStrict: sessionMocks.requireSessionStrict,
}));

vi.mock("@/lib/portal-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/portal-server")>();
  return {
    ...actual,
    requirePortalSession: sessionMocks.requirePortalSession,
  };
});

let db: typeof import("../lib/db");
let messagesRoute: typeof import("../app/api/messages/route");
let portalMessagesRoute: typeof import("../app/api/portal/messages/route");
let messageFileRoute: typeof import("../app/api/messages/file/[id]/route");
let messageVoiceRoute: typeof import("../app/api/messages/voice/[id]/route");

beforeAll(async () => {
  process.env.USE_LOCAL_DB = "true";
  process.env.PGLITE_DATA_DIR = "memory://";
  db = await import("../lib/db");
  messagesRoute = await import("../app/api/messages/route");
  portalMessagesRoute = await import("../app/api/portal/messages/route");
  messageFileRoute = await import("../app/api/messages/file/[id]/route");
  messageVoiceRoute = await import("../app/api/messages/voice/[id]/route");
});

describe("F-05c: حذف الرسائل الآمن بلا إتلاف تلقائي مع صلاحيات العهدة والتدقيق والحذف المتكرر", () => {
  it("يخفي الرسائل والمرفقات المحذوفة من الواجهة والتنزيل مع الاحتفاظ الكامل بالتخزين وتدقيق العملية ورفض الحذف المتكرر", async () => {
    const users = await db.listUsers();
    const admin = users.find((u) => u.username === "admin")!;
    const reception = users.find((u) => u.role === "reception") ?? users.find((u) => u.id !== admin.id)!;
    expect(admin).toBeDefined();
    expect(reception).toBeDefined();

    const patientA = await db.createPatient({
      fullName: "SYNTHETIC-MSG-RETENTION-PATIENT-A",
      phone: "770099111",
      altPhone: null,
      gender: "male",
      birthYear: 1990,
      address: null,
      medicalAlert: null,
      note: null,
    });
    const patientB = await db.createPatient({
      fullName: "SYNTHETIC-MSG-RETENTION-PATIENT-B",
      phone: "770099222",
      altPhone: null,
      gender: "female",
      birthYear: 1992,
      address: null,
      medicalAlert: null,
      note: null,
    });

    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 0x41),
    ]);
    const fileBase64 = pngBytes.toString("base64");
    const voiceBase64 = Buffer.from(
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    ).toString("base64");

    const fileMsg = await db.insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: patientA.id,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      body: "SYNTHETIC-RETAINED-PATIENT-CAPTION",
      kind: "file",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: "synthetic-xray-retain.png",
      fileMime: "image/png",
      fileSize: pngBytes.length,
      fileData: fileBase64,
    });

    const voiceMsg = await db.insertMessage({
      senderType: "user",
      senderUserId: admin.id,
      senderPatientId: null,
      recipientType: "patient",
      recipientUserId: null,
      recipientPatientId: patientA.id,
      body: "SYNTHETIC-RETAINED-VOICE-NOTE",
      kind: "voice",
      voiceMime: "audio/wav",
      voiceData: voiceBase64,
      voiceMs: 2500,
      fileName: null,
      fileMime: null,
      fileSize: null,
      fileData: null,
    });

    const quoteReply = await db.insertMessage({
      senderType: "user",
      senderUserId: admin.id,
      senderPatientId: null,
      recipientType: "patient",
      recipientUserId: null,
      recipientPatientId: patientA.id,
      body: "رد يقتبس المرفق قبل حذفه",
      kind: "text",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: null,
      fileMime: null,
      fileSize: null,
      fileData: null,
      replyToId: fileMsg.id,
    });

    // قبل الحذف: التنزيل مسموح للمريض صاحب الرسالة (200) ومرفوض للمريض الآخر (403)
    sessionMocks.requireSessionStrict.mockResolvedValue(null);
    sessionMocks.requirePortalSession.mockResolvedValue({
      mode: "patient",
      patientId: patientA.id,
      patientNumber: patientA.patientNumber,
      fullName: patientA.fullName,
      expiresAt: Date.now() + 3_600_000,
    });
    const preDeleteDownload = await messageFileRoute.GET(
      new Request(`http://localhost/api/messages/file/${fileMsg.id}`),
      { params: Promise.resolve({ id: String(fileMsg.id) }) },
    );
    expect(preDeleteDownload.status).toBe(200);

    // صلاحيات الحذف: مريض آخر أو موظف غير المرسِل أو عرض إداري للقراءة فقط يُرفض بـ 403 دون أي أثر في القاعدة أو audit_log
    sessionMocks.requirePortalSession.mockResolvedValue({
      mode: "patient",
      patientId: patientB.id,
      patientNumber: patientB.patientNumber,
      fullName: patientB.fullName,
      expiresAt: Date.now() + 3_600_000,
    });
    const wrongPatientDel = await portalMessagesRoute.DELETE(
      new Request(`http://localhost/api/portal/messages?id=${fileMsg.id}`, { method: "DELETE" }),
    );
    expect(wrongPatientDel.status).toBe(403);

    sessionMocks.requirePortalSession.mockResolvedValue({
      patientId: patientA.id,
      patientNumber: patientA.patientNumber,
      fullName: patientA.fullName,
      expiresAt: Date.now() + 600_000,
      adminPreview: {
        staffUserId: admin.id,
        staffUsername: admin.username,
        staffDisplayName: admin.displayName,
        staffRole: "admin",
        reason: "مراجعة اختبارية للقراءة فقط",
        startedAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      },
    });
    const previewDel = await portalMessagesRoute.DELETE(
      new Request(`http://localhost/api/portal/messages?id=${fileMsg.id}`, { method: "DELETE" }),
    );
    expect(previewDel.status).toBe(403);

    sessionMocks.requireSession.mockResolvedValue({
      userId: reception.id,
      username: reception.username,
      role: reception.role,
      expiresAt: Date.now() + 3_600_000,
    });
    const wrongStaffDel = await messagesRoute.DELETE(
      new Request(`http://localhost/api/messages?id=${voiceMsg.id}`, { method: "DELETE" }),
    );
    expect(wrongStaffDel.status).toBe(403);

    // حذف مرفق المريض من صاحب الرسالة عبر المسار الرسمي
    sessionMocks.requirePortalSession.mockResolvedValue({
      mode: "patient",
      patientId: patientA.id,
      patientNumber: patientA.patientNumber,
      fullName: patientA.fullName,
      expiresAt: Date.now() + 3_600_000,
    });
    const delFileRes = await portalMessagesRoute.DELETE(
      new Request(`http://localhost/api/portal/messages?id=${fileMsg.id}`, { method: "DELETE" }),
    );
    expect(delFileRes.status).toBe(200);
    const delFileJson = await delFileRes.json();
    expect(delFileJson.deletedAt).toBeTruthy();
    expect(delFileJson.body).toBeNull();
    expect(delFileJson.fileName).toBeNull();

    // حذف صوت الطاقم من صاحبه عبر المسار الرسمي
    const adminSession = {
      userId: admin.id,
      username: admin.username,
      role: "admin" as const,
      expiresAt: Date.now() + 3_600_000,
    };
    sessionMocks.requireSession.mockResolvedValue(adminSession);
    const delVoiceRes = await messagesRoute.DELETE(
      new Request(`http://localhost/api/messages?id=${voiceMsg.id}`, { method: "DELETE" }),
    );
    expect(delVoiceRes.status).toBe(200);
    const delVoiceJson = await delVoiceRes.json();
    expect(delVoiceJson.deletedAt).toBeTruthy();

    // 1) اختفاء المرفق والصوت من دوال ومسارات التنزيل للمخوّلين (404)، وبقاء 403 لغير المخوّلين
    expect(await db.fileMessagePayload(fileMsg.id)).toBeNull();
    expect(await db.voiceMessagePayload(voiceMsg.id)).toBeNull();

    sessionMocks.requireSessionStrict.mockResolvedValue(adminSession);
    sessionMocks.requirePortalSession.mockResolvedValue(null);
    const adminDeletedFileGet = await messageFileRoute.GET(
      new Request(`http://localhost/api/messages/file/${fileMsg.id}`),
      { params: Promise.resolve({ id: String(fileMsg.id) }) },
    );
    expect(adminDeletedFileGet.status).toBe(404);

    const adminDeletedVoiceGet = await messageVoiceRoute.GET(
      new Request(`http://localhost/api/messages/voice/${voiceMsg.id}`),
      { params: Promise.resolve({ id: String(voiceMsg.id) }) },
    );
    expect(adminDeletedVoiceGet.status).toBe(404);

    // مريض آخر (#patientB) يحاول تنزيل مرفق محذوف للمريض A: يُرفض بـ 403 لا 404 (منع كشف حالة الحذف)
    sessionMocks.requireSessionStrict.mockResolvedValue(null);
    sessionMocks.requirePortalSession.mockResolvedValue({
      mode: "patient",
      patientId: patientB.id,
      patientNumber: patientB.patientNumber,
      fullName: patientB.fullName,
      expiresAt: Date.now() + 3_600_000,
    });
    const crossPatientDeletedProbe = await messageFileRoute.GET(
      new Request(`http://localhost/api/messages/file/${fileMsg.id}`),
      { params: Promise.resolve({ id: String(fileMsg.id) }) },
    );
    expect(crossPatientDeletedProbe.status).toBe(403);

    // 2) اختفاء المحتوى واسم الملف والاقتباس من واجهة الخيط وقوائم المحادثات
    const thread = await db.patientThreadMessages(patientA.id);
    const deletedFileView = thread.find((m) => m.id === fileMsg.id)!;
    expect(deletedFileView.deletedAt).not.toBeNull();
    expect(deletedFileView.body).toBeNull();
    expect(deletedFileView.fileName).toBeNull();
    expect(deletedFileView.fileSize).toBeNull();

    const quoteView = thread.find((m) => m.id === quoteReply.id)!;
    expect(quoteView.replyTo?.deleted).toBe(true);
    expect(quoteView.replyTo?.body).toBeNull();
    expect(quoteView.replyTo?.fileName).toBeNull();

    // 3) عدم إتلاف النص أو الصوت أو المرفقات في جدول التخزين `messages` تلقائيًا
    const rawFileRow = await db.getPool().query<{
      body: string | null;
      file_name: string | null;
      file_mime: string | null;
      file_size: number | null;
      file_data: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT body, file_name, file_mime, file_size, file_data, deleted_at
         FROM messages WHERE id = $1`,
      [fileMsg.id],
    );
    expect(rawFileRow.rows[0]?.deleted_at).not.toBeNull();
    expect(rawFileRow.rows[0]?.body).toBe("SYNTHETIC-RETAINED-PATIENT-CAPTION");
    expect(rawFileRow.rows[0]?.file_name).toBe("synthetic-xray-retain.png");
    expect(rawFileRow.rows[0]?.file_mime).toBe("image/png");
    expect(rawFileRow.rows[0]?.file_size).toBe(pngBytes.length);
    expect(rawFileRow.rows[0]?.file_data).toBe(fileBase64);

    const rawVoiceRow = await db.getPool().query<{
      body: string | null;
      voice_mime: string | null;
      voice_ms: number | null;
      voice_data: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT body, voice_mime, voice_ms, voice_data, deleted_at
         FROM messages WHERE id = $1`,
      [voiceMsg.id],
    );
    expect(rawVoiceRow.rows[0]?.deleted_at).not.toBeNull();
    expect(rawVoiceRow.rows[0]?.body).toBe("SYNTHETIC-RETAINED-VOICE-NOTE");
    expect(rawVoiceRow.rows[0]?.voice_mime).toBe("audio/wav");
    expect(rawVoiceRow.rows[0]?.voice_ms).toBe(2500);
    expect(rawVoiceRow.rows[0]?.voice_data).toBe(voiceBase64);

    // 4) الحذف المتكرر يُرفض (already-deleted / 409) دون تغيير ختم الحذف أو تكرار سطر التدقيق
    const firstFileDeletedAt = rawFileRow.rows[0]!.deleted_at!.toISOString();
    const auditBeforeRepeat = await db.getPool().query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log
        WHERE entity = 'message' AND entity_id IN ($1, $2)
        ORDER BY id ASC`,
      [String(fileMsg.id), String(voiceMsg.id)],
    );
    expect(auditBeforeRepeat.rows).toHaveLength(2);
    expect(auditBeforeRepeat.rows.map((r) => r.action)).toEqual([
      "portal.message.delete",
      "message.delete",
    ]);

    sessionMocks.requirePortalSession.mockResolvedValue({
      mode: "patient",
      patientId: patientA.id,
      patientNumber: patientA.patientNumber,
      fullName: patientA.fullName,
      expiresAt: Date.now() + 3_600_000,
    });
    const repeatPortalDel = await portalMessagesRoute.DELETE(
      new Request(`http://localhost/api/portal/messages?id=${fileMsg.id}`, { method: "DELETE" }),
    );
    expect(repeatPortalDel.status).toBe(409);

    sessionMocks.requireSession.mockResolvedValue(adminSession);
    const repeatStaffDel = await messagesRoute.DELETE(
      new Request(`http://localhost/api/messages?id=${voiceMsg.id}`, { method: "DELETE" }),
    );
    expect(repeatStaffDel.status).toBe(409);

    const directRepeat = await db.deletePatientMessage(fileMsg.id, patientA.id);
    expect(directRepeat).toEqual({ ok: false, reason: "already-deleted" });

    const rawFileAfterRepeat = await db.getPool().query<{ deleted_at: Date }>(
      `SELECT deleted_at FROM messages WHERE id = $1`,
      [fileMsg.id],
    );
    expect(rawFileAfterRepeat.rows[0]!.deleted_at.toISOString()).toBe(firstFileDeletedAt);

    const auditAfterRepeat = await db.getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'message' AND entity_id IN ($1, $2)`,
      [String(fileMsg.id), String(voiceMsg.id)],
    );
    expect(auditAfterRepeat.rows).toHaveLength(2);

    // 5) صلاحيات العهدة الآمنة (`inspectRetainedDeletedMessage`) وتدقيق المعاينة
    const nonAdminInspect = await db.inspectRetainedDeletedMessage({
      actorSession: {
        userId: reception.id,
        username: reception.username,
        role: reception.role,
        expiresAt: Date.now() + 3_600_000,
      },
      messageId: fileMsg.id,
      reason: "محاولة غير مصرح بها لمعاينة سجل محذوف",
    });
    expect(nonAdminInspect.ok).toBe(false);
    if (!nonAdminInspect.ok) expect(nonAdminInspect.status).toBe(403);

    const noReasonInspect = await db.inspectRetainedDeletedMessage({
      actorSession: adminSession,
      messageId: fileMsg.id,
      reason: "قصير",
    });
    expect(noReasonInspect.ok).toBe(false);
    if (!noReasonInspect.ok) expect(noReasonInspect.status).toBe(400);

    const nonDeletedInspect = await db.inspectRetainedDeletedMessage({
      actorSession: adminSession,
      messageId: quoteReply.id,
      reason: "طلب معاينة رسالة غير محذوفة أصلًا",
    });
    expect(nonDeletedInspect.ok).toBe(false);
    if (!nonDeletedInspect.ok) expect(nonDeletedInspect.status).toBe(404);

    const validInspect = await db.inspectRetainedDeletedMessage({
      actorSession: adminSession,
      messageId: fileMsg.id,
      reason: "مراجعة تدقيق إداري لسجل مرفق محذوف",
      includeAttachmentBase64: true,
    });
    expect(validInspect.ok).toBe(true);
    if (validInspect.ok) {
      expect(validInspect.record.body).toBe("SYNTHETIC-RETAINED-PATIENT-CAPTION");
      expect(validInspect.record.fileName).toBe("synthetic-xray-retain.png");
      expect(validInspect.record.hasFileData).toBe(true);
      expect(validInspect.record.fileDataBase64).toBe(fileBase64);
    }

    const inspectAudit = await db.getPool().query<{
      action: string;
      actor: string;
      details: Record<string, unknown>;
    }>(
      `SELECT action, actor, details FROM audit_log
        WHERE action = 'message.retained.inspect' AND entity_id = $1`,
      [String(fileMsg.id)],
    );
    expect(inspectAudit.rows).toHaveLength(1);
    expect(inspectAudit.rows[0]?.actor).toBe(admin.username);
    expect(inspectAudit.rows[0]?.details?.reason).toBe("مراجعة تدقيق إداري لسجل مرفق محذوف");
  }, 30_000);
});
