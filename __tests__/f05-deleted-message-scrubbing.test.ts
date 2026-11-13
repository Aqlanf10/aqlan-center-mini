import { beforeAll, describe, expect, it } from "vitest";

/**
 * إثبات Red -> Green على PGlite في الذاكرة لمحو محتوى ومرفقات الرسائل المحذوفة (F-05):
 * عند حذف رسالة (نصية أو صوتية أو مرفق ملف) من الطاقم أو المريض:
 *  - يبقى شاهد الحذف (deletedAt / lastDeleted) في الخيط،
 *  - ولكن يُمحى النص واسم الملف وبيانات الصوت/الملف Base64 من القاعدة ومن واجهات JSON،
 *  - ولا يعود fileMessagePayload أو voiceMessagePayload بأي بايتات بعد الحذف.
 */

let db: typeof import("../lib/db");

beforeAll(async () => {
  process.env.USE_LOCAL_DB = "true";
  process.env.PGLITE_DATA_DIR = "memory://";
  db = await import("../lib/db");
});

describe("F-05c: محو بيانات المرفقات والنصوص فعليًا عند الحذف اللطيف للرسائل", () => {
  it("يمحو بايتات المرفق والصوت والنص من القاعدة ومن ردود الخيط عند حذف الرسالة مع إبقاء شاهد الحذف", async () => {
    const users = await db.listUsers();
    const admin = users.find((u) => u.username === "admin")!;
    expect(admin).toBeDefined();

    const patient = await db.createPatient({
      fullName: "SYNTHETIC-MSG-DELETE-PATIENT",
      phone: "770099111",
      altPhone: null,
      gender: "male",
      birthYear: 1990,
      address: null,
      medicalAlert: null,
      note: null,
    });

    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 0x41),
    ]);

    const fileMsg = await db.insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: patient.id,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      body: "SYNTHETIC-SECRET-CAPTION-TO-DELETE",
      kind: "file",
      voiceMime: null,
      voiceData: null,
      voiceMs: null,
      fileName: "synthetic-xray-delete.png",
      fileMime: "image/png",
      fileSize: pngBytes.length,
      fileData: pngBytes.toString("base64"),
    });

    const voiceMsg = await db.insertMessage({
      senderType: "user",
      senderUserId: admin.id,
      senderPatientId: null,
      recipientType: "patient",
      recipientUserId: null,
      recipientPatientId: patient.id,
      body: null,
      kind: "voice",
      voiceMime: "audio/wav",
      voiceData: Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=").toString("base64"),
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
      recipientPatientId: patient.id,
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

    // حذف مرفق المريض وحذف صوت الطاقم
    const delFile = await db.deletePatientMessage(fileMsg.id, patient.id);
    expect(delFile.ok).toBe(true);

    const delVoice = await db.deleteStaffMessage(voiceMsg.id, admin.id);
    expect(delVoice.ok).toBe(true);

    // 1. لا يمكن تنزيل بايتات الملف أو الصوت بعد الحذف إطلاقًا
    expect(await db.fileMessagePayload(fileMsg.id)).toBeNull();
    expect(await db.voiceMessagePayload(voiceMsg.id)).toBeNull();

    // 2. شاهد الحذف موجود في الخيط ولكن بدون تسريب النص أو اسم الملف المحذوف أو اقتباسه
    const thread = await db.patientThreadMessages(patient.id);
    const deletedFileView = thread.find((m) => m.id === fileMsg.id)!;
    expect(deletedFileView.deletedAt).not.toBeNull();
    expect(deletedFileView.body).toBeNull();
    expect(deletedFileView.fileName).toBeNull();

    const quoteView = thread.find((m) => m.id === quoteReply.id)!;
    expect(quoteView.replyTo?.deleted).toBe(true);
    expect(quoteView.replyTo?.body).toBeNull();
    expect(quoteView.replyTo?.fileName).toBeNull();
  }, 30_000);
});
