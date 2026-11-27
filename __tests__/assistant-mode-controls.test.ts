import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: vi.fn(), settings: vi.fn(), master: vi.fn(), user: vi.fn(), ai: vi.fn(), audit: vi.fn(),
  names: vi.fn(), process: vi.fn(), verify: vi.fn(), execute: vi.fn(), search: vi.fn(), access: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: m.session }));
vi.mock("@/lib/db", () => ({
  findUserByUsername: m.user, recordAudit: m.audit,
  personNameTokens: m.names, searchPatients: m.search,
}));
vi.mock("@/lib/assistant-mode-settings", () => ({ readAssistantControlSettings: m.settings }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/ai", () => ({ getAiSettings: m.master, aiChat: m.ai }));
vi.mock("@/lib/reports", () => ({ dbTodayISO: async () => "2026-11-27" }));
vi.mock("@/lib/assistant-engine", () => ({ detectPromptInjection: () => false, processAssistantQuery: m.process }));
vi.mock("@/lib/ai-confirmation", () => ({ verifyToolConfirmation: m.verify }));
vi.mock("@/lib/ai-tools/registry", () => ({ executeAiTool: m.execute }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: m.access }));

import { POST as chat } from "../app/api/ai/chat/route";
import { POST as confirmation } from "../app/api/ai/confirmation/route";
import { findAuthorizedPatientLink } from "../lib/assistant-patient-link";
import { assistantModes, EXTERNAL_ADMIN_TEMPLATES } from "../lib/assistant-modes";

const make = (body: object) => new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  m.session.mockResolvedValue({ userId: 22, username: "synthetic-admin", role: "admin" });
  m.user.mockResolvedValue({ id: 22, username: "synthetic-admin", isActive: true, permissions: { canUseAiChat: true } });
  m.settings.mockResolvedValue({});
  m.master.mockResolvedValue({ enabled: true, hasKey: true });
  m.names.mockResolvedValue(new Set<string>());
  m.ai.mockResolvedValue({ ok: true, content: "مسودة عامة.", model: "synthetic-cloud" });
  m.process.mockResolvedValue({ answer: "محلي", intent: "general_clinical", toolsUsed: [], sourceType: "internal_engine", model: "synthetic-local" });
});

describe("synthetic assistant mode matrix", () => {
  it("preserves the existing defaults; invalid saved settings do not enable a mode", () => {
    expect(assistantModes({})).toEqual({ internal: true, external: true });
    expect(assistantModes({ "ai.internal_assistant": "invalid", "ai.external_assistant": "false" })).toEqual({ internal: false, external: false });
  });
  it("answers a standalone greeting naturally without local tools or cloud", async () => {
    const reply = await (await chat(make({ message: "السَّلَامُ عليكم ورحمة الله وبركاته!" }))).json();
    expect(reply).toMatchObject({ intent: "greeting", reply: "وعليكم السلام ورحمة الله، كيف أقدر أساعدك؟" });
    expect(m.process).not.toHaveBeenCalled();
    expect(m.ai).not.toHaveBeenCalled();
  });
  it("internal on, external off blocks even previously enabled clinical egress", async () => {
    m.settings.mockResolvedValue({ "ai.external_assistant": "false", "ai.clinical_external": "true" });
    const reply = await (await chat(make({ message: EXTERNAL_ADMIN_TEMPLATES[0] }))).json();
    expect(reply.reply).toBe("محلي");
    expect(m.process).toHaveBeenCalledOnce();
    expect(m.ai).not.toHaveBeenCalled();
  });
  it("with both on sends only the allowed most recent administrative text", async () => {
    const reply = await (await chat(make({ messages: [{ role: "user", content: "SYNTHETIC_HISTORY" }, { role: "user", content: EXTERNAL_ADMIN_TEMPLATES[0] }] }))).json();
    expect(reply).toMatchObject({ sourceType: "external_ai", reply: "مسودة عامة." });
    expect(JSON.stringify(m.ai.mock.calls)).not.toContain("SYNTHETIC_HISTORY");
  });
  it.each(["administrative", "clinical"])("keeps a rejected patient-linked %s request local", async kind => {
    vi.stubEnv("USE_LOCAL_DB", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/test");
    try {
      m.user.mockResolvedValue({ id: 22, username: "synthetic-admin", isActive: true, partyId: 17, permissions: { canUseAiChat: true } });
      m.settings.mockResolvedValue({ "ai.clinical_external": "true" });
      m.access.mockResolvedValue(false);
      const response = await chat(make({ conversationPatientId: 303, message: kind === "clinical" ? "ألم الأسنان" : EXTERNAL_ADMIN_TEMPLATES[0] }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sourceType: "internal_engine", reply: "محلي" });
      expect(m.access).toHaveBeenCalledOnce();
      expect(m.process.mock.calls[0][1].conversationPatientId).toBeNull();
      expect(m.ai).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps authorized patient-linked administrative requests local", async () => {
    vi.stubEnv("USE_LOCAL_DB", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/test");
    try {
      m.access.mockResolvedValue(true);
      const response = await chat(make({ conversationPatientId: 303, message: EXTERNAL_ADMIN_TEMPLATES[0] }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sourceType: "internal_engine", reply: "محلي" });
      expect(m.access).toHaveBeenCalledOnce();
      expect(m.process.mock.calls[0][1].conversationPatientId).toBe(303);
      expect(m.ai).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps the local administrative answer when name redaction lookup fails", async () => {
    m.names.mockRejectedValue(new Error("synthetic redaction lookup unavailable"));
    const response = await chat(make({ message: "اكتب رسالة شكر إلى أحمد علي" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceType: "internal_engine", reply: "محلي" });
    expect(m.names).toHaveBeenCalledOnce();
    expect(m.process).toHaveBeenCalledOnce();
    expect(m.ai).not.toHaveBeenCalled();
  });
  it("masks registered names in clinical history before an explicitly enabled cloud consultation", async () => {
    m.user.mockResolvedValue({ id: 22, username: "synthetic-admin", isActive: true, partyId: 17, permissions: { canUseAiChat: true } });
    m.settings.mockResolvedValue({ "ai.clinical_external": "true" });
    m.names.mockResolvedValue(new Set(["syntheticname"]));
    const response = await chat(make({ messages: [
      { role: "user", content: "syntheticname" },
      { role: "assistant", content: "syntheticname" },
      { role: "user", content: "ألم الأسنان عند syntheticname" },
    ] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceType: "external_ai" });
    expect(m.names).toHaveBeenCalledOnce();
    expect(m.ai).toHaveBeenCalledOnce();
    const outbound = m.ai.mock.calls[0][0].messages;
    expect(JSON.stringify(outbound)).not.toContain("syntheticname");
    expect(outbound.slice(1).every((message: { content: string }) => message.content.includes("[اسم]"))).toBe(true);
  });
  it("removes explicit mixed registered and unregistered patient names before token masking", async () => {
    m.user.mockResolvedValue({ id: 22, username: "synthetic-admin", isActive: true, partyId: 17, permissions: { canUseAiChat: true } });
    m.settings.mockResolvedValue({ "ai.clinical_external": "true" });
    m.names.mockResolvedValue(new Set(["syntheticname"]));
    const response = await chat(make({ messages: [
      { role: "assistant", content: "المريض syntheticname syntheticfamily." },
      { role: "user", content: "المريض syntheticname syntheticfamily يعاني من ألم." },
    ] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceType: "external_ai" });
    expect(m.ai).toHaveBeenCalledOnce();
    const outbound = m.ai.mock.calls[0][0].messages.slice(1);
    expect(JSON.stringify(outbound)).not.toMatch(/syntheticname|syntheticfamily/);
    expect(outbound.every((message: { content: string }) => message.content.includes("[المريض]"))).toBe(true);
  });
  it("does not send clinical history if the registered-name lookup fails", async () => {
    m.user.mockResolvedValue({ id: 22, username: "synthetic-admin", isActive: true, partyId: 17, permissions: { canUseAiChat: true } });
    m.settings.mockResolvedValue({ "ai.clinical_external": "true" });
    m.names.mockRejectedValue(new Error("synthetic redaction lookup unavailable"));
    const response = await chat(make({ message: "ألم الأسنان عند syntheticname" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceType: "internal_engine", reply: "محلي" });
    expect(m.names).toHaveBeenCalledOnce();
    expect(m.ai).not.toHaveBeenCalled();
  });
  it("external only sends a server template and does not call the local engine or read patient context", async () => {
    m.settings.mockResolvedValue({ "ai.internal_assistant": "false", "ai.clinical_external": "true" });
    const reply = await (await chat(make({ messages: [{ role: "assistant", content: "SYNTHETIC_HISTORY" }, { role: "user", content: EXTERNAL_ADMIN_TEMPLATES[0] + "!" }] }))).json();
    expect(reply).toMatchObject({ sourceType: "external_ai", intent: "administrative_template", toolsUsed: [] });
    expect(m.ai.mock.calls[0][0].messages[1].content).toBe(EXTERNAL_ADMIN_TEMPLATES[0]);
    expect(m.process).not.toHaveBeenCalled();
    expect(m.access).not.toHaveBeenCalled();
  });
  it.each([
    ["افتح ملف المريض P-303", undefined],
    ["احجز موعد للمريض مثال", undefined],
    [EXTERNAL_ADMIN_TEMPLATES[0] + " للمريض P-303", undefined],
    [EXTERNAL_ADMIN_TEMPLATES[0], 303],
  ])("does not send unapproved requests or linked-patient context, case %s", async (message, conversationPatientId) => {
    m.settings.mockResolvedValue({ "ai.internal_assistant": "false", "ai.clinical_external": "true" });
    const reply = await (await chat(make({ message, conversationPatientId }))).json();
    expect(reply.intent).toBe("internal_assistant_disabled");
    expect(m.ai).not.toHaveBeenCalled();
    expect(m.process).not.toHaveBeenCalled();
  });
  it("does not fall back to the disabled local engine when the provider fails", async () => {
    m.settings.mockResolvedValue({ "ai.internal_assistant": "false" });
    m.ai.mockRejectedValue(new Error("synthetic timeout"));
    const reply = await chat(make({ message: EXTERNAL_ADMIN_TEMPLATES[0] }));
    expect(reply.status).toBe(503);
    expect(m.process).not.toHaveBeenCalled();
  });
  it.each(["disabled", "unreadable"])("does not run either engine when settings are %s", async mode => {
    if (mode === "unreadable") m.settings.mockRejectedValue(new Error("synthetic offline"));
    else m.settings.mockResolvedValue({ "ai.internal_assistant": "false", "ai.external_assistant": "false" });
    expect((await chat(make({ message: EXTERNAL_ADMIN_TEMPLATES[0] }))).status).toBe(503);
    expect(m.ai).not.toHaveBeenCalled();
    expect(m.process).not.toHaveBeenCalled();
  });
  it.each(["disabled", "unreadable"])("blocks a previously signed appointment when the master switch is %s", async mode => {
    if (mode === "disabled") m.master.mockResolvedValue({ enabled: false, hasKey: true });
    else m.master.mockRejectedValue(new Error("synthetic master settings unavailable"));
    m.verify.mockReturnValue({ userId: 22, tool: "book_appointment", params: { patientId: 303 } });
    expect((await confirmation(make({ token: "synthetic-signed-preview" }))).status).toBe(503);
    expect(m.master).toHaveBeenCalledOnce();
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it("allows the authorized local confirmation without a cloud key when both switches are on", async () => {
    m.master.mockResolvedValue({ enabled: true, hasKey: false });
    m.verify.mockReturnValue({ userId: 22, tool: "book_appointment", params: { patientId: 303 } });
    m.execute.mockResolvedValue({ success: true, textSummary: "synthetic success" });
    expect((await confirmation(make({ token: "synthetic-signed-preview" }))).status).toBe(200);
    expect(m.execute).toHaveBeenCalledOnce();
  });
  it("stops an existing appointment confirmation when the internal assistant is switched off", async () => {
    m.settings.mockResolvedValue({ "ai.internal_assistant": "false" });
    m.verify.mockReturnValue({ userId: 22, tool: "book_appointment", params: { patientId: 303 } });
    expect((await confirmation(make({ token: "synthetic-signed-preview" }))).status).toBe(503);
    expect(m.execute).not.toHaveBeenCalled();
  });
});

describe("opening an existing patient", () => {
  const context = { userId: 22, role: "doctor" as const, username: "synthetic-doctor", doctorPartyId: 17,
    canViewAllPatients: false, isDbConnected: true };
  it("returns only a link after authorization, without financial or clinical data", async () => {
    m.search.mockResolvedValue([{ id: 303, patientNumber: "P-00303", fullName: "حالة اصطناعية", medicalAlert: "SYNTHETIC_PRIVATE" }]);
    m.access.mockResolvedValue(true);
    const result = await findAuthorizedPatientLink("P-00303", context);
    expect(m.search).toHaveBeenCalledWith("P-00303", 8, 17);
    expect(m.access).toHaveBeenCalledWith(expect.objectContaining({ role: "doctor", partyId: 17 }), 303);
    expect(result.actions?.[0].href).toBe("/patients/303");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
    m.access.mockResolvedValue(false);
    expect((await findAuthorizedPatientLink("P-00303", context)).actions).toBeUndefined();
  });
  it("does not query for a patient link without an authenticated role", async () => {
    expect((await findAuthorizedPatientLink("P-00303", { ...context, role: undefined })).actions).toBeUndefined();
    expect(m.search).not.toHaveBeenCalled();
    expect(m.access).not.toHaveBeenCalled();
  });
  it("does not guess between matching names", async () => {
    m.search.mockResolvedValue([303, 304].map(id => ({ id, patientNumber: `P-${id}`, fullName: "حالة اصطناعية" })));
    expect((await findAuthorizedPatientLink("حالة اصطناعية", context)).actions).toBeUndefined();
    expect(m.access).not.toHaveBeenCalled();
  });
});
