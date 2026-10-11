import { notFound } from "next/navigation";
import { canManageStaff } from "@/lib/hr";
import { requireSession } from "@/lib/session";
import { getSettingsSafe } from "@/lib/db";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { getPayrollRunById, listPayrollItems } from "@/lib/hr-payroll";
import { formatAmount, CURRENCY_SHORT, type Currency } from "@/lib/money";
import {
  HR_PAYROLL_RUN_STATUS_LABELS,
  type HrPayrollItemView,
} from "@/lib/hr-payroll-shared";

export const dynamic = "force-dynamic";

export default async function PayrollPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!session || !canManageStaff(session.role)) {
    return <p className="p-6 text-sm">كشف مسير الرواتب للمدير وحده.</p>;
  }

  const { id } = await params;
  const run = await getPayrollRunById(id);
  if (!run) {
    notFound();
  }

  const items = await listPayrollItems(id);
  const settings = await getSettingsSafe();
  const currency = run.currency as Currency;

  return (
    <div className="mx-auto max-w-5xl p-6 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <PrintHeader title={run.status === "approved" ? "كشف مسير الرواتب والمستحقات المعتمد" : "كشف مسير الرواتب والمستحقات"} settings={settings} />

      <div className="my-6 space-y-4 text-sm text-gray-900">
        {/* Run Meta */}
        <div className="flex flex-wrap items-center justify-between border-b pb-3">
          <div>
            <span className="font-semibold text-gray-600">العملة: </span>
            <span className="font-bold text-base">
              {run.currency} ({CURRENCY_SHORT[currency] || run.currency})
            </span>
          </div>
          <div>
            <span className="font-semibold text-gray-600">الفترة: </span>
            <span className="font-bold">{run.periodName || run.periodKey || `دورة #${run.id}`}</span>
          </div>
          <div>
            <span className="font-semibold text-gray-600">الحالة: </span>
            <span className="font-bold">{HR_PAYROLL_RUN_STATUS_LABELS[run.status] || run.status}</span>
          </div>
          <div>
            <span className="font-semibold text-gray-600">تاريخ الاعتماد: </span>
            <span>{run.approvedAt ? run.approvedAt.slice(0, 10) : "قيد المراجعة"}</span>
          </div>
        </div>

        {/* Table of items */}
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs border border-collapse border-gray-300">
            <thead className="bg-gray-100 font-bold border-b border-gray-300">
              <tr>
                <th className="p-2 border">#</th>
                <th className="p-2 border">اسم الموظف / الطبيب</th>
                <th className="p-2 border">المسمى الوظيفي</th>
                <th className="p-2 border">الراتب الأساسي</th>
                <th className="p-2 border">البدلات</th>
                <th className="p-2 border">نسب الأطباء</th>
                <th className="p-2 border">الخصميات والغياب</th>
                <th className="p-2 border">صافي المستحق</th>
                <th className="p-2 border">المصروف</th>
                <th className="p-2 border">توقيع المستلم</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 font-mono">
              {items.map((item: HrPayrollItemView, idx: number) => (
                <tr key={item.id} className="border-b">
                  <td className="p-2 border text-center font-sans">{idx + 1}</td>
                  <td className="p-2 border font-sans font-bold">{item.staffName || `موظف #${item.staffId}`}</td>
                  <td className="p-2 border font-sans text-gray-600">{item.staffJobTitle || "—"}</td>
                  <td className="p-2 border">{formatAmount(item.baseSalaryMinor, currency)}</td>
                  <td className="p-2 border">{formatAmount(item.allowancesMinor, currency)}</td>
                  <td className="p-2 border font-bold text-emerald-800">
                    {item.commissionsMinor > 0 ? formatAmount(item.commissionsMinor, currency) : "—"}
                  </td>
                  <td className="p-2 border text-rose-800">
                    {item.deductionsMinor > 0 ? `-${formatAmount(item.deductionsMinor, currency)}` : "—"}
                  </td>
                  <td className="p-2 border font-bold text-black">{formatAmount(item.netDueMinor, currency)}</td>
                  <td className="p-2 border text-emerald-900">{formatAmount(item.paidMinor, currency)}</td>
                  <td className="p-2 border font-sans text-center text-gray-400">....................</td>
                </tr>
              ))}
            </tbody>
            {/* Totals Footer */}
            <tfoot className="bg-gray-100 font-bold font-mono border-t-2 border-gray-400">
              <tr>
                <td colSpan={3} className="p-2 border font-sans text-center">
                  الإجماليات الكلية ({run.currency}):
                </td>
                <td className="p-2 border">{formatAmount(run.totalBaseSalaryMinor, currency)}</td>
                <td className="p-2 border">{formatAmount(run.totalAllowancesMinor, currency)}</td>
                <td className="p-2 border text-emerald-800">{formatAmount(run.totalCommissionsMinor, currency)}</td>
                <td className="p-2 border text-rose-800">-{formatAmount(run.totalDeductionsMinor, currency)}</td>
                <td className="p-2 border font-bold text-black">{formatAmount(run.totalNetDueMinor, currency)}</td>
                <td className="p-2 border text-emerald-900">{formatAmount(run.totalPaidMinor, currency)}</td>
                <td className="p-2 border"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Triple Signatures Block */}
        <div className="mt-12 pt-8 grid grid-cols-3 text-center text-xs">
          <div>
            <div className="font-bold mb-8">إعداد مسؤول الموارد البشرية</div>
            <div className="text-gray-400">............................................</div>
          </div>
          <div>
            <div className="font-bold mb-8">تدقيق ومراجعة الحسابات</div>
            <div className="text-gray-400">............................................</div>
          </div>
          <div>
            <div className="font-bold mb-8">اعتماد المدير العام</div>
            <div className="text-gray-400">............................................</div>
          </div>
        </div>
      </div>

      <PrintFooter settings={settings} />
    </div>
  );
}
