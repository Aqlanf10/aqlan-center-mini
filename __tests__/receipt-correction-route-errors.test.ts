import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/payments/[id]/correct maps a typed domain refusal from a shared financial guard exactly as
 * /api/payments maps it (unauthorized → 403, invalid → 400, every other typed code → 409), with the
 * guard's safe Arabic message and code. Any other exception stays a generic 500 without the raw error,
 * and the existing session/role gates and refusal-reason messages are unchanged. The correction writer
 * is mocked here; the real-guard path is covered on PostgreSQL by split-allocation-reversal.test.ts.
 */
const mocks = vi.hoisted(() => ({ requireSession: vi.fn(), correctPayment: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(), correctPayment: mocks.correctPayment }));

const { POST } = await import("../app/api/payments/[id]/correct/route");
const { DebtRepaymentError } = await import("../lib/debt-installments-db");

const admin = { userId: 1, username: "synthetic-admin", role: "admin" };
const send = async (session: unknown = admin) => {
  mocks.requireSession.mockResolvedValue(session);
  const response = await POST(new Request("http://localhost/api/payments/7/correct", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "synthetic-correct-key" },
    body: JSON.stringify({ mode: "void", reason: "Synthetic void" }),
  }), { params: Promise.resolve({ id: "7" }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

beforeEach(() => { mocks.requireSession.mockReset(); mocks.correctPayment.mockReset(); });

describe("correction route error mapping", () => {
  it.each([
    ["unauthorized", 403], ["invalid", 400], ["stale", 409], ["conflict", 409], ["missing", 409],
  ] as const)("a typed %s refusal answers %i with its safe message and code", async (code, status) => {
    mocks.correctPayment.mockRejectedValue(new DebtRepaymentError(code, "رسالة رفض اصطناعية آمنة."));
    expect(await send()).toEqual({ status, body: { message: "رسالة رفض اصطناعية آمنة.", code } });
  });

  it("an unknown exception stays a generic 500 and never exposes the raw error", async () => {
    mocks.correctPayment.mockRejectedValue(new Error('duplicate key value violates unique constraint "payments_pkey" DETAIL: secret'));
    const sent = await send();
    expect(sent).toEqual({ status: 500, body: { message: "تعذّر تصحيح السند. أعد المحاولة." } });
    expect(JSON.stringify(sent.body)).not.toMatch(/duplicate|constraint|secret/);
  });

  it("refusal reasons returned by the writer keep their existing messages", async () => {
    mocks.correctPayment.mockResolvedValue({ reason: "already_reversed" });
    const sent = await send();
    expect(sent.status).toBe(409);
    expect(sent.body.message).toBe("هذا السند معكوسٌ بالكامل سلفًا — لا شيء يُصحَّح فيه.");
  });

  it("session and role gates are unchanged and run before the writer", async () => {
    expect((await send(null)).status).toBe(401);
    for (const role of ["reception", "cashier", "doctor", "accountant"]) expect((await send({ ...admin, role })).status).toBe(403);
    expect(mocks.correctPayment).not.toHaveBeenCalled();
  });
});
