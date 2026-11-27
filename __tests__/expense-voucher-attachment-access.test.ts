import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getBytes } from "../app/api/expense-attachments/[id]/route";
import { GET as list, POST as upload } from "../app/api/expenses/[id]/attachments/route";

const deps = vi.hoisted(() => ({
  session: vi.fn(), expense: vi.fn(), attachment: vi.fn(), list: vi.fn(), storage: vi.fn(), read: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: deps.session }));
vi.mock("@/lib/db", () => ({
  getExpense: deps.expense, getExpenseAttachment: deps.attachment, listExpenseAttachments: deps.list,
}));
vi.mock("@/lib/files", () => ({ readFileByKey: deps.read, storageStatus: deps.storage }));

const context = { params: Promise.resolve({ id: "31" }) };
const request = new Request("http://localhost/synthetic");

beforeEach(() => {
  vi.resetAllMocks();
  deps.session.mockResolvedValue({ role: "reception", username: "desk-fixture" });
  deps.attachment.mockResolvedValue({ attachment: { expenseId: 72, title: "fixture.pdf", mimeType: "application/pdf" }, storageKey: "synthetic" });
  deps.list.mockResolvedValue([{ id: 31 }]);
  deps.read.mockResolvedValue(Buffer.from("fixture"));
});

describe("expense attachments deny reception regardless of voucher ownership", () => {
  it("does not list, read storage or accept uploads on a voucher from other staff", async () => {
    deps.expense.mockResolvedValue({ createdBy: "other-fixture" });
    const [indexed, bytes, write] = await Promise.all([list(request, context), getBytes(request, context), upload(request, context)]);
    expect([indexed.status, bytes.status, write.status]).toEqual([403, 403, 403]);
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.storage).not.toHaveBeenCalled();
    expect(deps.expense).not.toHaveBeenCalled();
    expect(deps.attachment).not.toHaveBeenCalled();
  });

  it("denies even the receptionist's own historical voucher before data access", async () => {
    deps.expense.mockResolvedValue({ createdBy: "desk-fixture" });
    const responses = await Promise.all([list(request, context), getBytes(request, context), upload(request, context)]);
    expect(responses.map(response => response.status)).toEqual([403, 403, 403]);
    expect(deps.expense).not.toHaveBeenCalled();
    expect(deps.attachment).not.toHaveBeenCalled();
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.storage).not.toHaveBeenCalled();
  });

  it("retains admin review but denies a clinical role before fetching data", async () => {
    deps.session.mockResolvedValueOnce({ role: "admin", username: "admin-fixture" });
    expect((await getBytes(request, context)).status).toBe(200);
    deps.attachment.mockClear();
    deps.session.mockResolvedValueOnce({ role: "doctor", username: "doctor-fixture" });
    expect((await getBytes(request, context)).status).toBe(403);
    expect(deps.attachment).not.toHaveBeenCalled();
  });
});
