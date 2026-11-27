import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../app/api/ai/confirmation/route";

const m = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "admin-synthetic" }) }));
vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: m.query }),
  findUserByUsername: async () => ({ id: 7, isActive: true, username: "admin-synthetic" }),
  recordAudit: m.audit,
}));
vi.mock("@/lib/ai-confirmation", () => ({ verifyToolConfirmation: () => ({ tool: "synthetic", userId: 7, params: {}, jti: "synthetic" }) }));
vi.mock("@/lib/ai-tools/policy", () => ({ resolveToolPolicy: () => ({ canonicalName: "synthetic", requiresConfirmation: true }) }));
vi.mock("@/lib/ai-tools/registry", () => ({ executeAiTool: m.execute }));
vi.mock("@/lib/reports", () => ({ dbTodayISO: async () => "2026-11-27" }));

const confirm = () => POST(new Request("http://localhost/synthetic", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "synthetic-confirmation" }),
}));

beforeEach(() => { vi.resetAllMocks(); });

it.each([false, null])("does not dispatch or audit an execution when not explicitly enabled: %j", async (enabled) => {
  m.query.mockResolvedValue({ rows: enabled === null ? [] : [{ enabled }] });
  expect((await confirm()).status).toBe(503);
  expect(m.execute).not.toHaveBeenCalled();
  expect(m.audit).not.toHaveBeenCalled();
});

it("does not dispatch when the current switch cannot be read", async () => {
  m.query.mockRejectedValue(new Error("synthetic unavailable"));
  expect((await confirm()).status).toBe(503);
  expect(m.execute).not.toHaveBeenCalled();
  expect(m.audit).not.toHaveBeenCalled();
});

it("retains the existing confirmation path when the master switch is enabled", async () => {
  m.query.mockResolvedValue({ rows: [{ enabled: true }] });
  m.execute.mockResolvedValue({ success: true, textSummary: "synthetic" });
  expect((await confirm()).status).toBe(200);
  expect(m.execute).toHaveBeenCalledTimes(1);
  expect(m.audit).toHaveBeenCalledTimes(1);
});
