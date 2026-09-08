import { beforeEach, describe, expect, it, vi } from "vitest";
import { canUseAiChat } from "../lib/roles";
import {
  parseDoctorPermissions,
  DEFAULT_DOCTOR_PERMISSIONS,
  RECEPTION_PERMISSIONS,
  ADMIN_PERMISSIONS,
} from "../lib/doctor-permissions";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  findUserByUsername: vi.fn(),
  recordAudit: vi.fn(),
  getAiSettings: vi.fn(),
  aiChat: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: mocks.requireSession,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    findUserByUsername: mocks.findUserByUsername,
    recordAudit: mocks.recordAudit,
  };
});

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ai")>();
  return {
    ...actual,
    getAiSettings: mocks.getAiSettings,
    aiChat: mocks.aiChat,
  };
});

import { POST as chatRoute, DENTAL_ASSISTANT_SYSTEM_PROMPT } from "../app/api/ai/chat/route";

describe("نظام صلاحيات المساعد الذكي (canUseAiChat & RBAC)", () => {
  it("المدير يملك الصلاحية دائمًا مهما كانت الكائنات الممررة", () => {
    expect(canUseAiChat("admin", null)).toBe(true);
    expect(canUseAiChat("admin", { canUseAiChat: false })).toBe(true);
    expect(canUseAiChat("admin")).toBe(true);
  });

  it("الطبيب يملك الصلاحية افتراضيًا وتُحجب عنه إذا عُطلت صراحة", () => {
    expect(canUseAiChat("doctor", null)).toBe(true);
    expect(canUseAiChat("doctor", undefined)).toBe(true);
    expect(canUseAiChat("doctor", { canUseAiChat: true })).toBe(true);
    expect(canUseAiChat("doctor", { canUseAiChat: false })).toBe(false);
  });

  it("الاستقبال محجوب افتراضيًا وتُفتح له الصلاحية فقط إذا فُعلت من الإدارة", () => {
    expect(canUseAiChat("reception", null)).toBe(false);
    expect(canUseAiChat("reception", undefined)).toBe(false);
    expect(canUseAiChat("reception", { canUseAiChat: false })).toBe(false);
    expect(canUseAiChat("reception", { canUseAiChat: true })).toBe(true);
  });

  it("أي دور غير معروف أو غير مصرح به يُرفض افتراضيًا", () => {
    expect(canUseAiChat("guest", null)).toBe(false);
    expect(canUseAiChat(null, null)).toBe(false);
    expect(canUseAiChat(undefined)).toBe(false);
  });
});

describe("تحليل الصلاحيات وقيمها الافتراضية (parseDoctorPermissions)", () => {
  it("القيم الافتراضية للأدوار تطابق الدستور الطبي", () => {
    expect(ADMIN_PERMISSIONS.canUseAiChat).toBe(true);
    expect(DEFAULT_DOCTOR_PERMISSIONS.canUseAiChat).toBe(true);
    expect(RECEPTION_PERMISSIONS.canUseAiChat).toBe(false);
  });

  it("parseDoctorPermissions يدعم تخصيص الصلاحية للطبيب والاستقبال", () => {
    // طبيب معطل
    const doctorDisabled = parseDoctorPermissions(JSON.stringify({ canUseAiChat: false }), "doctor");
    expect(doctorDisabled.canUseAiChat).toBe(false);

    // استقبال معطل افتراضيًا
    const receptionDefault = parseDoctorPermissions(null, "reception");
    expect(receptionDefault.canUseAiChat).toBe(false);

    // استقبال مفعل من قبل الإدارة
    const receptionEnabled = parseDoctorPermissions(JSON.stringify({ canUseAiChat: true }), "reception");
    expect(receptionEnabled.canUseAiChat).toBe(true);

    // مدير مفعل دائمًا
    const admin = parseDoctorPermissions(JSON.stringify({ canUseAiChat: false }), "admin");
    expect(admin.canUseAiChat).toBe(true);
  });
});

describe("مسار استدعاء المساعد الذكي (POST /api/ai/chat)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSession.mockResolvedValue({
      userId: 1,
      username: "dr.ahmed",
      role: "doctor",
    });
    mocks.findUserByUsername.mockResolvedValue({
      id: 1,
      username: "dr.ahmed",
      displayName: "د. أحمد علي",
      role: "doctor",
      isActive: true,
      partyId: 3, /* طبيب مربوط بجهة طبيب — هوية سريرية للاستشارة السريرية النصية (مراجعة P0) */
      permissions: { canUseAiChat: true },
    });
    mocks.getAiSettings.mockResolvedValue({
      enabled: true,
      hasKey: true,
      model: "glm-4.6",
    });
    mocks.aiChat.mockResolvedValue({
      ok: true,
      content: "الجرعة المعتادة لأوجمنتين 1 جم مرتين يومياً لمدة 7 أيام.",
      model: "glm-4.6",
      latencyMs: 350,
    });
  });

  it("يرفض الطلب غير الموثق برمز 401", async () => {
    mocks.requireSession.mockResolvedValue(null);
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "مرحبا" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(401);
  });

  it("يرفض المستخدم غير النشط أو غير الموجود برمز 403", async () => {
    mocks.findUserByUsername.mockResolvedValue(null);
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "مرحبا" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(403);
  });

  it("يرفض المستخدم الذي لا يملك صلاحية المساعد الذكي برمز 403", async () => {
    // موظف استقبال بدون تفعيل الصلاحية
    mocks.requireSession.mockResolvedValue({
      userId: 2,
      username: "reception",
      role: "reception",
    });
    mocks.findUserByUsername.mockResolvedValue({
      id: 2,
      username: "reception",
      role: "reception",
      isActive: true,
      permissions: { canUseAiChat: false },
    });

    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "كيف أتعامل مع حالة طارئة؟" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.message).toContain("صلاحية");
  });

  it("يرفض الطلب بدون نص رسالة برمز 400", async () => {
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(400);
  });

  it("يرفض إذا كانت خدمة الذكاء الاصطناعي معطلة من الإعدادات برمز 503", async () => {
    mocks.getAiSettings.mockResolvedValue({
      enabled: false,
      hasKey: false,
      model: "glm-4.6",
    });
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "استفسار طبي" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(503);
  });

  it("يقبل استفسار الطبيب المصرح له ويحقن الدستور الطبي وحارس الخصوصية", async () => {
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "المريض هاتفه 0777123456 يعاني من ألم عصب شديد",
      }),
    });

    const res = await chatRoute(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.reply).toContain("أوجمنتين");

    // تحقق من الرسائل المرسلة لـ aiChat
    expect(mocks.aiChat).toHaveBeenCalledTimes(1);
    const callArg = mocks.aiChat.mock.calls[0][0];
    const msgs = callArg.messages;

    // حقن برومبت المساعد الدستوري (المادة 214)
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe(DENTAL_ASSISTANT_SYSTEM_PROMPT);
    expect(msgs[0].content).toContain("المادة 214");

    // تعقيم هاتف المريض قبل الخروج (حارس الخصوصية)
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).not.toContain("0777123456");
    expect(msgs[1].content).toContain("•••");

    // تسجيل التدقيق
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.chat",
        actor: "dr.ahmed",
      }),
    );
  });

  it("يسمح لموظف الاستقبال عند تفعيل الصلاحية له صراحة", async () => {
    mocks.requireSession.mockResolvedValue({
      userId: 3,
      username: "reception_lead",
      role: "reception",
    });
    mocks.findUserByUsername.mockResolvedValue({
      id: 3,
      username: "reception_lead",
      role: "reception",
      isActive: true,
      permissions: { canUseAiChat: true },
    });

    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "ما هي أوقات عمل العيادة في رمضان؟" }),
    });

    const res = await chatRoute(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

describe("\u062d\u0627\u0631\u0633 \u0627\u0644\u0642\u0635\u062f \u0627\u0644\u0633\u0631\u064a\u0631\u064a \u0644\u0644\u0627\u0633\u062a\u0634\u0627\u0631\u0629 \u0627\u0644\u062e\u0627\u0631\u062c\u064a\u0629 (\u0645\u0631\u0627\u062c\u0639\u0629 P0)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSession.mockResolvedValue({
      userId: 2,
      username: "reception2",
      role: "reception",
    });
    mocks.findUserByUsername.mockResolvedValue({
      id: 2,
      username: "reception2",
      role: "reception",
      isActive: true,
      partyId: null,
      permissions: { canUseAiChat: true }, /* \u0641\u0639\u0651\u0644 \u0644\u0647 \u0627\u0644\u0645\u0633\u0627\u0639\u062f \u0627\u0644\u0625\u062f\u0627\u0631\u064a \u0644\u0627 \u0627\u0644\u0642\u0631\u0627\u0631 \u0627\u0644\u0633\u0631\u064a\u0631\u064a */
    });
    mocks.getAiSettings.mockResolvedValue({
      enabled: true,
      hasKey: true,
      model: "glm-4.6",
    });
    mocks.aiChat.mockResolvedValue({
      ok: true,
      content: "\u0627\u0644\u062c\u0631\u0639\u0629 \u0627\u0644\u0645\u0639\u062a\u0627\u062f\u0629 \u0644\u0623\u0648\u062c\u0645\u0646\u062a\u064a\u0646 1 \u062c\u0645 \u0645\u0631\u062a\u064a\u0646 \u064a\u0648\u0645\u064a\u064b\u0627.",
      model: "glm-4.6",
      latencyMs: 100,
    });
  });

  it("\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0645\u0639 canUseAiChat=true \u064a\u0633\u0623\u0644 \u0633\u0624\u0627\u0644\u064b\u0627 \u062f\u0648\u0627\u0626\u064a\u064b\u0627: \u0644\u0627 \u062a\u064f\u0633\u062a\u062f\u0639\u0649 \u0627\u0644\u0645\u0632\u0648\u062f \u0627\u0644\u062e\u0627\u0631\u062c\u064a \u0644\u0644\u0627\u0633\u062a\u0634\u0627\u0631\u0629 \u0627\u0644\u0633\u0631\u064a\u0631\u064a\u0629", async () => {
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "\u0645\u0627 \u0627\u0644\u0645\u0636\u0627\u062f \u0627\u0644\u062d\u064a\u0648\u064a \u0627\u0644\u0645\u0646\u0627\u0633\u0628 \u0644\u0644\u062e\u0631\u0627\u062c \u0645\u0639 \u0627\u0644\u062c\u0631\u0639\u0629\u061f" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(200);
    /* \u0644\u0627 \u064a\u0635\u0644 \u0627\u0644\u0645\u0632\u0648\u062f \u0627\u0644\u062e\u0627\u0631\u062c\u064a: \u0627\u0644\u0631\u062f \u0645\u0646 \u0627\u0644\u0645\u062d\u0631\u0643 \u0627\u0644\u0645\u062d\u0644\u064a \u0636\u0645\u0646 \u0635\u0644\u0627\u062d\u064a\u0627\u062a\u0647\u061b \u0648\u0644\u064a\u0633 \u062c\u0631\u0639\u0629 \u062f\u0648\u0627\u0621 \u0645\u0646 \u0646\u0645\u0648\u0630\u062c \u062e\u0627\u0631\u062c\u064a. */
    expect(mocks.aiChat).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.reply).not.toContain("\u0623\u0648\u062c\u0645\u0646\u062a\u064a\u0646");
    expect((data.warnings || []).some((w: string) => w.includes("هوية سريرية"))).toBe(true);
  });

  it("\u0627\u0644\u0637\u0628\u064a\u0628 \u0627\u0644\u0645\u0631\u0628\u0648\u0637 \u0628\u062c\u0647\u0629 \u0637\u0628\u064a\u0628 \u064a\u0635\u0644 \u0644\u0644\u0627\u0633\u062a\u0634\u0627\u0631\u0629 \u0627\u0644\u0633\u0631\u064a\u0631\u064a\u0629 \u0627\u0644\u062e\u0627\u0631\u062c\u064a\u0629 \u0643\u0627\u0644\u0639\u0627\u062f\u0629", async () => {
    mocks.requireSession.mockResolvedValue({
      userId: 5,
      username: "dr.sara",
      role: "doctor",
      partyId: 9,
    });
    mocks.findUserByUsername.mockResolvedValue({
      id: 5,
      username: "dr.sara",
      role: "doctor",
      isActive: true,
      partyId: 9,
      permissions: { canUseAiChat: true },
    });
    const req = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "\u0645\u0627 \u0627\u0644\u0645\u0636\u0627\u062f \u0627\u0644\u062d\u064a\u0648\u064a \u0627\u0644\u0645\u0646\u0627\u0633\u0628 \u0644\u0644\u062e\u0631\u0627\u062c\u061f" }),
    });
    const res = await chatRoute(req);
    expect(res.status).toBe(200);
    expect(mocks.aiChat).toHaveBeenCalled();
    const data = await res.json();
    expect(data.reply).toContain("\u0623\u0648\u062c\u0645\u0646\u062a\u064a\u0646");
  });
});
