import { operationalStatus, operationalStatusLabel } from "@/lib/hr-operational-employment-shared";
import { canManageStaff, listStaff } from "@/lib/hr";
import { requireSession } from "@/lib/session";
import { getSettingsSafe } from "@/lib/db";
import { dbTodayISO } from "@/lib/reports";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { HR_CONTRACT_KIND_LABEL, HR_DEPARTMENT_LABEL, HR_SALARY_PERIOD_LABEL, HR_WORK_STATUS_LABEL } from "@/lib/hr";
import { PAY_BLOCKER_LABEL } from "@/lib/hr-pay-terms";
import { isCurrency, formatAmount, CURRENCY_SHORT } from "@/lib/money";

export const dynamic = "force-dynamic";

/**
 * كشف الطاقم وشروط الأجر — ملف طباعةٍ مستقل منظّم للمدير وحده.
 *
 * قرأه الخادم بجلسةٍ موقَّعة قبل أن يُولَّد: غير المدير لا يصل إلى الصفحة أصلًا
 * (الباب يردّه)، والمسار نفسه يفحص من جديد. المبالغ هنا بعملاتها كما حُفظت —
 * لا إجمالي يجمع عملاتٍ مختلفة، فلكل عملة مجموعها وحدها.
 */
export default async function HrStaffPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ department?: string | string[]; status?: string | string[] }>;
}) {
  const session = await requireSession();
  if (!session || !canManageStaff(session.role)) {
    return <p className="p-6 text-sm">كشف الطاقم بشروط الأجر للمدير وحده.</p>;
  }
  const params = await searchParams;
  const departmentParam = typeof params.department === "string" ? params.department : undefined;
  const statusParam = typeof params.status === "string" ? params.status : undefined;

  const staff = await listStaff({
    department: departmentParam && departmentParam !== "" ? (departmentParam as never) : null,
    status: statusParam && statusParam !== "" ? (statusParam as never) : null,
    includePayTerms: true,
  });
  const settings = await getSettingsSafe();

  // Same documented source/day as the private staff reader. This is a display
  // total of monthly terms, never payroll accrual or a decision about deductions.
  const reportAsOf = staff[0]?.currentPay?.asOf ?? await dbTodayISO();
  const salaryTotalsByCurrency = new Map<string, number>();
  for (const member of staff) {
    const pay = member.currentPay, terms = pay?.terms;
    if (terms?.salaryMinor != null && terms.currency && terms.salaryPeriod === "monthly"
      && pay?.blockers.length === 0 && operationalStatus(member) !== "ended" && operationalStatus(member) !== "unknown") {
      salaryTotalsByCurrency.set(terms.currency, (salaryTotalsByCurrency.get(terms.currency) ?? 0) + terms.salaryMinor);
    }
  }

  return (
    <div className="print-sheet hr-staff-sheet" dir="rtl">
      <PrintHeader settings={settings} title="كشف الطاقم وشروط الأجر" />
      <p className="report-meta">
        صادر بتاريخ {friendlyDateLong(new Date().toISOString())} — عدد الملفات: {staff.length}
        {departmentParam ? ` — القسم: ${HR_DEPARTMENT_LABEL[departmentParam as never]}` : ""}
        {statusParam ? ` — الحالة: ${HR_WORK_STATUS_LABEL[statusParam as never]}` : ""}
      </p>

      <table className="report-table hr-staff-table">
        <thead>
          <tr>
            <th>#</th>
            <th>الاسم</th>
            <th>المسمّى الوظيفي</th>
            <th>القسم</th>
            <th>حالة العمل</th>
            <th>الالتحاق</th>
            <th>الانتهاء</th>
            <th>نوع التعاقد</th>
            <th>الراتب</th>
            <th>العملة</th>
            <th>الدورية</th>
            <th>سريان المبلغ</th>
            <th>الحساب</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((member, index) => {
            const pay = member.currentPay, terms = pay?.terms;
            return (
            <tr key={member.id}>
              <td className="num">{index + 1}</td>
              <td>{member.fullName}</td>
              <td>{member.jobTitle || "—"}</td>
              <td>{HR_DEPARTMENT_LABEL[member.department]}</td>
              <td>{operationalStatusLabel(member)}</td>
              <td className="num">{member.hireDate ?? "—"}</td>
              <td className="num">{member.endDate ?? "—"}</td>
              <td>{terms ? HR_CONTRACT_KIND_LABEL[terms.kind] : "غير محسوم"}
                <div>{pay?.source === "contract" ? `العقد ${pay.contract?.contractNumber} — إصدار ${pay.contract?.versionNumber}` : pay?.source === "staff_profile" ? "شروط الملف الابتدائية" : "مصدر الأجر يحتاج مراجعة"}</div>
              </td>
              <td className="num">{terms?.salaryMinor != null && terms.currency ? formatAmount(terms.salaryMinor, terms.currency) : "—"}
                {Boolean(pay?.blockers.length) && <div dir="rtl">{pay!.blockers.map(code => PAY_BLOCKER_LABEL[code]).join("؛ ")}</div>}
              </td>
              <td className="num">{terms?.currency ? `${terms.currency} (${CURRENCY_SHORT[terms.currency]})` : "—"}</td>
              <td>{terms?.salaryPeriod ? HR_SALARY_PERIOD_LABEL[terms.salaryPeriod] : "—"}</td>
              <td className="num">{pay?.effectiveOn ?? "—"}</td>
              <td>{member.userId !== null ? "مرتبط" : "بلا حساب"}</td>
            </tr>
          ); })}
          {staff.length === 0 && (
            <tr><td colSpan={13} className="empty">لا ملفات مطابقة.</td></tr>
          )}
        </tbody>
      </table>

      {salaryTotalsByCurrency.size > 0 && (
        <section className="hr-salary-summary">
          <h3>إجمالي الرواتب الشهرية الجارية حتى تاريخ التقرير ({reportAsOf}) — كل عملةٍ بمجموعها</h3>
          <ul>
            {[...salaryTotalsByCurrency.entries()].map(([currency, totalMinor]) => (
              <li key={currency}>
                <span className="num">{formatAmount(totalMinor, isCurrency(currency) ? currency : "YER")}</span> {currency}
              </li>
            ))}
          </ul>
          <p className="hr-note">إجمالي الشروط الشهرية الموثقة للعرض، وليس استحقاق مسير. لا يدخل مصدر أجر محجوب للمراجعة أو تاريخ عمل مجهول أو ملف منتهٍ؛ الإيقاف لا يُفسر كخصم.</p>
        </section>
      )}
      <p className="hr-note">نسب العقود لا تُجمع مع الراتب هنا. الاستحقاق الفعلي يتبع سياسة محرك العمولات ومسار المسير المعتمد. يوم العيادة ومصدر شروط الأجر: {reportAsOf}</p>

      <PrintFooter settings={settings} />
      <PrintButton />
    </div>
  );
}
