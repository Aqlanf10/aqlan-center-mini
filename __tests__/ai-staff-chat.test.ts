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
