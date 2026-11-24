import { beforeEach, describe, expect, it, vi } from "vitest";

// All payloads are synthetic. Denials must happen before any expense/database/file read.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), list: vi.fn(), findUser: vi.fn(), settings: vi.fn(),
  record: vi.fn(), void: vi.fn(), attachment: vi.fn(), attachments: vi.fn(),
  readFile: vi.fn(), getExpense: vi.fn(), putFile: vi.fn(), storage: vi.fn(),
  recordAttachment: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: mocks.findUser,
  getSettings: mocks.settings,
  listExpensesBetween: mocks.list,
  ratesFromSettings: () => ({}),
  recordExpense: mocks.record,
  voidExpense: mocks.void,
  getExpenseAttachment: mocks.attachment,
  listExpenseAttachments: mocks.attachments,
  getExpense: mocks.getExpense,
  recordExpenseAttachment: mocks.recordAttachment,
  recordAudit: mocks.audit,
}));
vi.mock("@/lib/files", () => ({
  readFileByKey: mocks.readFile, putFile: mocks.putFile, storageStatus: mocks.storage,
}));
import { GET as getExpenses, POST as postExpenses } from "../app/api/expenses/route";
import { POST as quoteExpense } from "../app/api/expenses/quote/route";
import { GET as getExpenseAttachment } from "../app/api/expense-attachments/[id]/route";
import { GET as getExpenseFiles, POST as postExpenseFile } from "../app/api/expenses/[id]/attachments/route";

function signIn(role: "reception" | "admin" | "cashier" | "accountant") {
  mocks.session.mockResolvedValue({
    role, userId: 1, username: "synthetic-staff", expiresAt: Date.now() + 60_000,
    financeAccess: { createExpenses: true },
  });
}
const url = "https://synthetic.invalid/api/expenses";
const fileContext = { params: Promise.resolve({ id: "1" }) };
const get = () => new Request(url);
const post = () => new Request(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 100, currency: "YER", category: "synthetic" }),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([{ id: 1, voucherNumber: "SYNTHETIC-VOUCHER" }]);
});

describe("P1 server-side expense isolation for reception", () => {
  it("refuses voucher lists and expense creation/quotes before financial database calls", async () => {
    signIn("reception");
    expect((await getExpenses(get())).status).toBe(403);
    expect((await postExpenses(post())).status).toBe(403);
    expect((await quoteExpense(post())).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it("refuses expense attachments, their bytes, and uploading them before storage access", async () => {
    signIn("reception");
    expect((await getExpenseFiles(get(), fileContext)).status).toBe(403);
    expect((await postExpenseFile(post(), fileContext)).status).toBe(403);
    expect((await getExpenseAttachment(get(), fileContext)).status).toBe(403);
    expect(mocks.attachments).not.toHaveBeenCalled();
    expect(mocks.attachment).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(mocks.getExpense).not.toHaveBeenCalled();
  });

  it("preserves expense read access for authorized admin, accountant and cashier", async () => {
    for (const role of ["admin", "accountant", "cashier"] as const) {
      signIn(role);
      const response = await getExpenses(get());
      expect(response.status).toBe(200);
      expect((await response.json()).expenses).toEqual([{ id: 1, voucherNumber: "SYNTHETIC-VOUCHER" }]);
    }
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("preserves missing-session 401 without consulting finance storage", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await getExpenses(get())).status).toBe(401);
    expect((await quoteExpense(post())).status).toBe(401);
    expect((await getExpenseAttachment(get(), fileContext)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.attachment).not.toHaveBeenCalled();
  });
});
