import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { userId: 7, username: "reception_demo", role: "reception" as string, expiresAt: Date.now() + 3_600_000 },
  envelope: { kind: "legacy" as const },
  openShift: { id: 42, status: "open", openedBy: "reception_demo", openedAt: "2026-11-27T06:00:00Z", opening: { YER: 50000, SAR: 0, USD: 0 } },
}));

vi.mock("@/lib/session", () => ({
  requireSession: vi.fn(async () => mocks.session),
}));
vi.mock("@/lib/staff-session-admission", () => ({
  selectRequestStaffEnvelope: vi.fn(async () => mocks.envelope),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getOpenShift: vi.fn(async () => mocks.openShift),
    listOpeningReviews: vi.fn(async () => []),
    listShiftsForViewer: vi.fn(async () => [{ id: 41, status: "closed", sealed: true, counted: null }]),
    listExpensesBetween: vi.fn(async () => [{ id: 1, amountMinor: 10000 }]),
    getDocumentForDownload: vi.fn(async () => ({
      document: { id: 9, patientId: 2, title: "intraoral.jpg", mimeType: "image/jpeg", removedAt: null },
      storageKey: "ab/cd",
    })),
    getExpenseAttachment: vi.fn(async () => ({
      attachment: { id: 3, expenseId: 1, title: "voucher.jpg", mimeType: "image/jpeg" },
      storageKey: "ef/gh",
    })),
  };
});

import { canReadExpenseVoucher } from "@/lib/expense-voucher-access";
import { canPrintShiftReport } from "@/lib/shift-print-permissions";
import { canAccessUnifiedReport } from "@/lib/report-access";
import { GET as getExpenses, POST as postExpense } from "@/app/api/expenses/route";
import { GET as getExpenseAttachments, POST as postExpenseAttachment } from "@/app/api/expenses/[id]/attachments/route";
import { GET as getExpenseAttachmentById } from "@/app/api/expense-attachments/[id]/route";
import { GET as getDocumentById } from "@/app/api/documents/[id]/route";
import { GET as getPatientDocuments } from "@/app/api/patients/[id]/documents/route";
import { GET as getPatientFullFile } from "@/app/api/patients/[id]/route";
import { GET as getShifts } from "@/app/api/shifts/route";

describe("Reception privacy, shift Z-report boundary, and complete expense block (§15 / TD-01)", () => {
  beforeEach(() => {
    mocks.session = { userId: 7, username: "reception_demo", role: "reception", expiresAt: Date.now() + 3_600_000 };
    mocks.envelope = { kind: "legacy" };
  });

  it("denies Reception access to all expense vouchers (including own-created legacy rows) and clinic Z-reports", () => {
    expect(canReadExpenseVoucher({ username: "reception_demo", role: "reception" }, { createdBy: "reception_demo" })).toBe(false);
    expect(canReadExpenseVoucher({ username: "admin", role: "admin" }, { createdBy: "reception_demo" })).toBe(true);
    expect(canPrintShiftReport("reception")).toBe(false);
    expect(canPrintShiftReport("admin")).toBe(true);
  });

  it("returns 403 for Reception on GET/POST /api/expenses and expense attachments", async () => {
    const resList = await getExpenses(new Request("http://localhost/api/expenses"));
    expect(resList.status).toBe(403);

    const resCreate = await postExpense(
      new Request("http://localhost/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "req_reception_block_0001" },
        body: JSON.stringify({ category: "supplies", payeeText: "Test", amount: "1000", currency: "YER" }),
      }),
    );
    expect(resCreate.status).toBe(403);

    const resAttList = await getExpenseAttachments(new Request("http://localhost/api/expenses/1/attachments"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(resAttList.status).toBe(403);

    const resAttPost = await postExpenseAttachment(new Request("http://localhost/api/expenses/1/attachments", { method: "POST" }), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(resAttPost.status).toBe(403);

    const resAttRead = await getExpenseAttachmentById(new Request("http://localhost/api/expense-attachments/3"), {
      params: Promise.resolve({ id: "3" }),
    });
    expect(resAttRead.status).toBe(403);
  });

  it("blocks Reception from unprojected full clinical patient file, stored clinical photos, and clinic revenue/commission reports", async () => {
    const resFullFile = await getPatientFullFile(new Request("http://localhost/api/patients/2"), {
      params: Promise.resolve({ id: "2" }),
    });
    expect(resFullFile.status).toBe(403);

    const resDocList = await getPatientDocuments(new Request("http://localhost/api/patients/2/documents"), {
      params: Promise.resolve({ id: "2" }),
    });
    expect(resDocList.status).toBe(403);

    const resDocDownload = await getDocumentById(new Request("http://localhost/api/documents/9"), {
      params: Promise.resolve({ id: "9" }),
    });
    expect(resDocDownload.status).toBe(403);

    for (const blockedReport of ["daily", "monthly", "annual", "doctor-commission", "commission-detail", "daily-outflow", "expense-payees", "lab", "suppliers"]) {
      expect(canAccessUnifiedReport("reception", blockedReport)).toBe(false);
    }
    expect(canAccessUnifiedReport("reception", "appointments")).toBe(true);
    expect(canAccessUnifiedReport("reception", "patient-statement")).toBe(true);
  });

  it("projects GET /api/shifts for Reception with open status & sealed shift history while omitting clinic totals, expenses, opening cash, and drawer balance", async () => {
    const resShift = await getShifts();
    expect(resShift.status).toBe(200);
    const body = await resShift.json();
    expect(body).toEqual({
      clinicTimeZone: expect.any(String),
      open: {
        id: 42,
        status: "open",
        openedBy: "reception_demo",
        openedAt: "2026-11-27T06:00:00Z",
        openingReviews: [],
      },
      recent: [{ id: 41, status: "closed", sealed: true, counted: null }],
    });
    expect(body.open.opening).toBeUndefined();
    expect(body.totals).toBeUndefined();
    expect(body.expenseTotals).toBeUndefined();
    expect(body.payments).toBeUndefined();
    expect(body.expenses).toBeUndefined();
    expect(body.drawer).toBeUndefined();
  });

  it("keeps ReceptionShift UI completely free of expense creation forms or voucher links", () => {
    const src = readFileSync(resolve(process.cwd(), "app/finance/ReceptionShift.tsx"), "utf8");
    expect(src).not.toContain("/api/expenses");
    expect(src).not.toContain("ShiftExpenseForm");
    expect(src).not.toContain("/print/voucher");
  });
});
