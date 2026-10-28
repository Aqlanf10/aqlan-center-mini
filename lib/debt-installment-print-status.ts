/** Presentation only: amounts remain owned by debtInstallmentProgress. Dates are
 * ISO clinic dates supplied by the authenticated print route, not browser time. */
export function debtInstallmentPrintStatus(row: {
  settledMinor: number; remainingMinor: number; dueDate: string;
}, today: string) {
  if (row.remainingMinor === 0) return { tone: "paid", label: "مسدد بالكامل" };
  if (row.dueDate < today) return { tone: "overdue", label: row.settledMinor > 0 ? "مسدد جزئيًا · متأخر" : "غير مسدد · متأخر" };
  if (row.settledMinor > 0) return { tone: "partial", label: row.dueDate === today ? "مسدد جزئيًا · مستحق اليوم" : "مسدد جزئيًا" };
  return { tone: "pending", label: row.dueDate === today ? "غير مسدد · مستحق اليوم" : "غير مسدد · لم يحل موعده" };
}
