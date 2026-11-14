import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * إثبات Red -> Green لمرفقات الرسائل والمستندات F-05 (بيانات اصطناعية بحتة):
 *  1) فحص الصلاحية وعزل المريض/المحادثة قبل تحميل بايتات Base64 من القاعدة (منع استنزاف الذاكرة 403).
 *  2) فرض قائمة بيضاء صارمة لنوع المحتوى عند التسليم (تحويل أي SVG/HTML موروث إلى octet-stream + attachment).
 */

const mocks = vi.hoisted(() => ({
  requireSessionStrict: vi.fn(),
  requireSession: vi.fn(),
  requirePortalSession: vi.fn(),
  canAccessPatient: vi.fn(),
  fileMessagePayload: vi.fn(),
  voiceMessagePayload: vi.fn(),
  getMessageAttachmentMeta: vi.fn(),
  getDocumentForDownload: vi.fn(),
  getExpenseAttachment: vi.fn(),
  readFileByKey: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSessionStrict: mocks.requireSessionStrict,
  requireSession: mocks.requireSession,
}));

vi.mock("@/lib/portal-server", () => ({
  requirePortalSession: mocks.requirePortalSession,
}));

vi.mock("@/lib/patient-access", () => ({
  canAccessPatient: mocks.canAccessPatient,
}));

vi.mock("@/lib/files", () => ({
  readFileByKey: mocks.readFileByKey,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    fileMessagePayload: mocks.fileMessagePayload,
    voiceMessagePayload: mocks.voiceMessagePayload,
    getMessageAttachmentMeta: mocks.getMessageAttachmentMeta,
    getDocumentForDownload: mocks.getDocumentForDownload,
    getExpenseAttachment: mocks.getExpenseAttachment,
  };
});

import { GET as getMessageFile } from "../app/api/messages/file/[id]/route";
import { GET as getMessageVoice } from "../app/api/messages/voice/[id]/route";
import { GET as getDocument } from "../app/api/documents/[id]/route";
import { GET as getExpenseAttachmentRoute } from "../app/api/expense-attachments/[id]/route";

const SYNTHETIC_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const SYNTHETIC_SVG_BYTES = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePortalSession.mockResolvedValue(null);
  mocks.requireSessionStrict.mockResolvedValue(null);
  mocks.requireSession.mockResolvedValue(null);
  mocks.canAccessPatient.mockResolvedValue(true);
});

describe("F-05a: التحقق من الصلاحية قبل تحميل بايتات المرفقات من القاعدة", () => {
  it("يرفض بـ 403 موظفًا ثالثًا يحاول فتح مرفق محادثة خاصة بين زميلين دون استدعاء fileMessagePayload", async () => {
    mocks.requireSessionStrict.mockResolvedValue({
      userId: 33,
      username: "reception1",
      role: "reception",
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.getMessageAttachmentMeta.mockResolvedValue({
      mime: "image/png",
      senderType: "user",
      senderUserId: 1,
      senderPatientId: null,
      recipientType: "user",
      recipientUserId: 2,
      recipientPatientId: null,
    });
    mocks.fileMessagePayload.mockResolvedValue({
      mime: "image/png",
      name: "private.png",
      size: SYNTHETIC_PNG_BYTES.length,
      data: SYNTHETIC_PNG_BYTES.toString("base64"),
      senderType: "user",
      senderUserId: 1,
      senderPatientId: null,
      recipientType: "user",
      recipientUserId: 2,
      recipientPatientId: null,
    });

    const res = await getMessageFile(new Request("http://localhost/api/messages/file/701"), {
      params: Promise.resolve({ id: "701" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.fileMessagePayload).not.toHaveBeenCalled();
  });

  it("يرفض بـ 403 طبيبًا مقيدًا يحاول فتح مرفق مريض خارج نطاقه أو جلسة بوابة لمريض آخر دون تحميل البايتات", async () => {
    mocks.requireSessionStrict.mockResolvedValue({
      userId: 11,
      username: "dr.scoped",
      role: "doctor",
      partyId: 5,
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.canAccessPatient.mockResolvedValue(false);
    mocks.getMessageAttachmentMeta.mockResolvedValue({
      mime: "audio/webm",
      senderType: "patient",
      senderUserId: null,
      senderPatientId: 77,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
    });
    mocks.voiceMessagePayload.mockResolvedValue({
      mime: "audio/webm",
      data: Buffer.from("SYNTHETIC-VOICE").toString("base64"),
      senderType: "patient",
      senderUserId: null,
      senderPatientId: 77,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
    });

    const voiceRes = await getMessageVoice(new Request("http://localhost/api/messages/voice/702"), {
      params: Promise.resolve({ id: "702" }),
    });
    expect(voiceRes.status).toBe(403);
    expect(mocks.voiceMessagePayload).not.toHaveBeenCalled();

    // جلسة بوابة مريض آخر (#42 يحاول قراءة مرفق المريض #77)
    mocks.requireSessionStrict.mockResolvedValue(null);
    mocks.requirePortalSession.mockResolvedValue({
      patientId: 42,
      accountId: 10,
      mode: "patient",
    });
    const portalRes = await getMessageFile(new Request("http://localhost/api/messages/file/702"), {
      params: Promise.resolve({ id: "702" }),
    });
    expect(portalRes.status).toBe(403);
    expect(mocks.fileMessagePayload).not.toHaveBeenCalled();
  });
});

describe("F-05b: تحصين ترويسات Content-Type وContent-Disposition ضد الأنواع الخطرة الموروثة", () => {
  it("يجبر أي سجل موروث بنوع image/svg+xml في مرفقات الرسائل على application/octet-stream + attachment", async () => {
    mocks.requirePortalSession.mockResolvedValue({
      patientId: 42,
      accountId: 10,
      mode: "patient",
    });
    mocks.getMessageAttachmentMeta.mockResolvedValue({
      mime: "image/svg+xml",
      senderType: "patient",
      senderUserId: null,
      senderPatientId: 42,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
    });
    mocks.fileMessagePayload.mockResolvedValue({
      mime: "image/svg+xml",
      name: "legacy.svg",
      size: SYNTHETIC_SVG_BYTES.length,
      data: SYNTHETIC_SVG_BYTES.toString("base64"),
      senderType: "patient",
      senderUserId: null,
      senderPatientId: 42,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
    });

    const res = await getMessageFile(new Request("http://localhost/api/messages/file/705"), {
      params: Promise.resolve({ id: "705" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("يجبر أي سجل موروث بنوع image/svg+xml أو text/html في مستندات المرضى ومرفقات المصروفات والصوتيات على octet-stream", async () => {
    mocks.requireSession.mockResolvedValue({
      userId: 1,
      username: "admin",
      role: "admin",
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.readFileByKey.mockResolvedValue(SYNTHETIC_SVG_BYTES);
    mocks.getDocumentForDownload.mockResolvedValue({
      storageKey: "aa/bb/synthetic.svg",
      document: {
        id: 801,
        patientId: 42,
        title: "legacy-doc.svg",
        mimeType: "image/svg+xml",
        removedAt: null,
      },
    });

    const docRes = await getDocument(new Request("http://localhost/api/documents/801"), {
      params: Promise.resolve({ id: "801" }),
    });
    expect(docRes.status).toBe(200);
    expect(docRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(docRes.headers.get("content-disposition")).toMatch(/^attachment;/);

    mocks.getExpenseAttachment.mockResolvedValue({
      storageKey: "aa/bb/synthetic.html",
      attachment: {
        id: 802,
        expenseId: 12,
        title: "legacy-receipt.html",
        mimeType: "text/html",
      },
    });
    const expRes = await getExpenseAttachmentRoute(
      new Request("http://localhost/api/expense-attachments/802"),
      { params: Promise.resolve({ id: "802" }) },
    );
    expect(expRes.status).toBe(200);
    expect(expRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(expRes.headers.get("content-disposition")).toMatch(/^attachment;/);

    mocks.requireSessionStrict.mockResolvedValue({
      userId: 1,
      username: "admin",
      role: "admin",
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.getMessageAttachmentMeta.mockResolvedValue({
      mime: "text/html",
      senderType: "patient",
      senderUserId: null,
      senderPatientId: 42,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
    });
    mocks.voiceMessagePayload.mockResolvedValue({
      mime: "text/html",
      data: SYNTHETIC_SVG_BYTES.toString("base64"),
      senderType: "patient",
      senderUserId: null,
      senderPatientId: 42,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
    });
    const voiceRes = await getMessageVoice(new Request("http://localhost/api/messages/voice/803"), {
      params: Promise.resolve({ id: "803" }),
    });
    expect(voiceRes.status).toBe(200);
    expect(voiceRes.headers.get("content-type")).toBe("application/octet-stream");
  });
});
