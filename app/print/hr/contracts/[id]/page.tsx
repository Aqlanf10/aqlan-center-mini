import { notFound } from "next/navigation";
import { canManageStaff } from "@/lib/hr";
import { requireSession } from "@/lib/session";
import { getSettingsSafe } from "@/lib/db";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { getContractById, listContractAddenda } from "@/lib/hr-contracts-attendance";
import {
  HR_CONTRACT_TEMPLATE_LABEL,
  HR_CONTRACT_STATUS_LABEL,
  type HrContractView,
} from "@/lib/hr-contracts-attendance-shared";
import { formatAmount, CURRENCY_SHORT, type Currency } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function ContractPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!session || !canManageStaff(session.role)) {
    return <p className="p-6 text-sm">طباعة العقود للمدير وحده.</p>;
  }

  const { id } = await params;
  const contract = await getContractById(id);
  if (!contract) {
    notFound();
  }

  const addenda = await listContractAddenda(id);
  const settings = await getSettingsSafe();

  const clinicName = settings["clinic.name"] || "مركز عقلان لطب وجراحة الأسنان";
  const currency = (contract.salaryCurrency || "YER") as Currency;
  const baseSalary = contract.baseSalaryMinor ?? 0;
  const commissionRate = contract.commissionRatePercent || 0;
  const jobTitle = contract.termsPayload?.jobDescription || contract.title;
  const clauses = contract.termsPayload?.clauses?.join("\n") || contract.notes;

  return (
    <div className="mx-auto max-w-4xl p-6 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <PrintHeader title="عقد عمل وظيفي رسمي" settings={settings} />

      <div className="my-6 space-y-6 text-sm leading-relaxed text-gray-900">
        {/* Header summary */}
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <span className="font-semibold text-gray-600">رقم العقد: </span>
            <span className="font-mono font-bold">{contract.contractNumber}</span>
          </div>
          <div>
            <span className="font-semibold text-gray-600">تاريخ الإبرام: </span>
            <span>{contract.startDate}</span>
          </div>
          <div>
            <span className="font-semibold text-gray-600">الحالة: </span>
            <span className="font-bold">{HR_CONTRACT_STATUS_LABEL[contract.status] || contract.status}</span>
          </div>
        </div>

        {/* Parties introduction */}
        <div className="rounded-lg bg-gray-50 p-4 border border-gray-200">
          <p className="font-bold mb-2">إنه في يوم الموافق {contract.startDate} تم الاتفاق والتراضي بين كلٍ من:</p>
          <div className="space-y-2">
            <p>
              <span className="font-bold">الطرف الأول: </span>
              {clinicName}، ويمثله في التوقيع الإدارة العامة.
            </p>
            <p>
              <span className="font-bold">الطرف الثاني: </span>
              الأخ/الأخت: <span className="font-bold text-base">{contract.staffName}</span>
              {jobTitle && <span> — المسمى الوظيفي: {jobTitle}</span>}.
            </p>
          </div>
        </div>

        {/* Contract Core Terms */}
        <div className="space-y-3">
          <h3 className="font-bold text-base border-b pb-1">أولاً: نطاق ونوع التعاقد</h3>
          <p>
            اتفق الطرفان على أن يعمل الطرف الثاني لدى الطرف الأول بموجب (
            <span className="font-bold">{HR_CONTRACT_TEMPLATE_LABEL[contract.templateKind] || contract.templateKind}</span>)، وتحت إشراف وإدارة الطرف الأول.
          </p>

          <h3 className="font-bold text-base border-b pb-1 pt-2">ثانياً: مدة العقد وفترة التجربة</h3>
          <p>
            يبدأ سريان هذا العقد من تاريخ <span className="font-bold">{contract.startDate}</span>
            {contract.endDate ? (
              <span> وينتهي بتاريخ <span className="font-bold">{contract.endDate}</span> ما لم يتم تجديده باتفاق الطرفين.</span>
            ) : (
              <span> ويعتبر سارياً لمدة غير محددة حتى إشعار آخر.</span>
            )}
            {contract.probationEndDate && (
              <span> وتعتبر الفترة حتى تاريخ <span className="font-bold">{contract.probationEndDate}</span> فترة تجربة واختبار.</span>
            )}
          </p>

          <h3 className="font-bold text-base border-b pb-1 pt-2">ثالثاً: المقابل المالي والأجر</h3>
          <div className="space-y-1">
            {baseSalary > 0 && (
              <p>
                - الراتب الأساسي الشهري:{" "}
                <span className="font-bold font-mono">
                  {formatAmount(baseSalary, currency)} {CURRENCY_SHORT[currency] || currency}
                </span>
                .
              </p>
            )}
            {commissionRate > 0 && (
              <p>
                - نسبة الإنجاز المالي للأطباء:{" "}
                <span className="font-bold text-emerald-800">{commissionRate}%</span> من صافي دخل العمليات المنجزة وفق سجلات النظام الآلي للمركز.
              </p>
            )}
            {contract.termsPayload?.workingHoursSummary && (
              <p>- ساعات العمل: {contract.termsPayload.workingHoursSummary}</p>
            )}
          </div>

          {clauses && (
            <>
              <h3 className="font-bold text-base border-b pb-1 pt-2">رابعاً: البنود والشروط العامة</h3>
              <div className="whitespace-pre-wrap leading-relaxed">{clauses}</div>
            </>
          )}

          {/* Addenda if any */}
          {addenda.length > 0 && (
            <>
              <h3 className="font-bold text-base border-b pb-1 pt-2">الملاحق الملحقة بهذا العقد</h3>
              <div className="space-y-3">
                {addenda.map((ad: HrContractView) => (
                  <div key={ad.id} className="rounded-lg border p-3 bg-gray-50">
                    <div className="font-bold">
                      {ad.title} ({ad.contractNumber}) — ساري من: {ad.startDate}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-xs text-gray-700">
                      {ad.addendumReason || ad.notes || "—"}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Signatures */}
        <div className="mt-12 pt-8 border-t grid grid-cols-2 text-center">
          <div>
            <div className="font-bold mb-12">توقيع وختم الطرف الأول (المركز)</div>
            <div className="text-xs text-gray-500">............................................</div>
          </div>
          <div>
            <div className="font-bold mb-12">توقيع الطرف الثاني (الموظف)</div>
            <div className="text-xs text-gray-500">............................................</div>
          </div>
        </div>
      </div>

      <PrintFooter settings={settings} />
    </div>
  );
}
