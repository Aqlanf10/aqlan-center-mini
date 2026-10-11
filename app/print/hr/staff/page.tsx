import { canManageStaff, listStaff } from "@/lib/hr";
import { requireSession } from "@/lib/session";
import { getSettingsSafe } from "@/lib/db";
import { dbTodayISO } from "@/lib/reports";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { HR_CONTRACT_KIND_LABEL, HR_DEPARTMENT_LABEL, HR_SALARY_PERIOD_LABEL, HR_WORK_STATUS_LABEL } from "@/lib/hr";
import { isCurrency, formatAmount, CURRENCY_SHORT } from "@/lib/money";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

  // مجموع لكل عملة على حدة — لا يجتمع الريال بالدولار أبدًا في سطر واحد.
  // «الجاري» يُحسم بتاريخ التقرير **كما تراه القاعدة بتوقيت المركز** (dbTodayISO
  // لا حساب UTC): شروطٌ بتاريخ سريانٍ لاحقٍ عليه لا تدخل الإجمالي — تظهر في
  // صفوفها بأثناءها فقط.
  const reportAsOf = await dbTodayISO();
  const salaryTotalsByCurrency = new Map<string, number>();
  for (const member of staff) {
    if (
      member.payTerms
      && member.workStatus !== "ended"
      && member.payTerms.period === "monthly"
      && member.payTerms.effectiveOn <= reportAsOf
    ) {
      salaryTotalsByCurrency.set(
        member.payTerms.currency,
        (salaryTotalsByCurrency.get(member.payTerms.currency) ?? 0) + member.payTerms.amountMinor,
      );
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
          {staff.map((member, index) => (
            <tr key={member.id}>
              <td className="num">{index + 1}</td>
              <td>{member.fullName}</td>
              <td>{member.jobTitle || "—"}</td>
              <td>{HR_DEPARTMENT_LABEL[member.department]}</td>
              <td>{HR_WORK_STATUS_LABEL[member.workStatus]}</td>
              <td className="num">{member.hireDate ?? "—"}</td>
              <td className="num">{member.endDate ?? "—"}</td>
              <td>{HR_CONTRACT_KIND_LABEL[member.contractKind]}</td>
              <td className="num">{member.payTerms ? formatAmount(member.payTerms.amountMinor, isCurrency(member.payTerms.currency) ? member.payTerms.currency : "YER") : "—"}</td>
              <td className="num">{member.payTerms ? `${member.payTerms.currency}${isCurrency(member.payTerms.currency) ? ` (${CURRENCY_SHORT[member.payTerms.currency]})` : ""}` : "—"}</td>
              <td>{member.payTerms ? HR_SALARY_PERIOD_LABEL[member.payTerms.period] : "—"}</td>
              <td className="num">{member.payTerms?.effectiveOn ?? "—"}</td>
              <td>{member.userId !== null ? "مرتبط" : "بلا حساب"}</td>
            </tr>
          ))}
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
          <p className="hr-note">لا يدخل الإجمالي شرطُ راتبٍ بتاريخ سريانٍ لاحقٍ على تاريخ التقرير.</p>
        </section>
      )}
      <p className="hr-note">تعاقدات «النسبة» للطبيبين تُقرأ من مصدر العمولات الحالي في الجهات ولا تظهر هنا كمبالغ راتب.</p>

      <PrintFooter settings={settings} />
      <PrintButton />
    </div>
  );
}
