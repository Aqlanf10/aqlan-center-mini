import { describe, expect, it } from "vitest";
import { debtInstallmentPrintStatus } from "../lib/debt-installment-print-status";

describe("saved contract textual payment status (clinic date)", () => {
  const today = "2026-10-28";
  it.each([
    [0, 100, "2026-10-29", "pending", "غير مسدد · لم يحل موعده"],
    [0, 100, today, "pending", "غير مسدد · مستحق اليوم"],
    [0, 100, "2026-10-27", "overdue", "غير مسدد · متأخر"],
    [50, 50, "2026-10-29", "partial", "مسدد جزئيًا"],
    [50, 50, today, "partial", "مسدد جزئيًا · مستحق اليوم"],
    [50, 50, "2026-10-27", "overdue", "مسدد جزئيًا · متأخر"],
    [100, 0, "2026-10-27", "paid", "مسدد بالكامل"],
    [100, 0, "2026-10-29", "paid", "مسدد بالكامل"],
  ])("%s paid, %s remaining, due %s", (settledMinor, remainingMinor, dueDate, tone, label) => {
    expect(debtInstallmentPrintStatus({ settledMinor, remainingMinor, dueDate }, today)).toEqual({ tone, label });
  });
});
