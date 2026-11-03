import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getMyHrSummary } from "@/lib/hr-self-service";
import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DAY_NAMES: Record<number, string> = {
  0: "الأحد",
  1: "الإثنين",
  2: "الثلاثاء",
  3: "الأربعاء",
  4: "الخميس",
  5: "الجمعة",
  6: "السبت",
};

const ATT_STATUS_LABEL: Record<string, string> = {
  present: "حاضر",
  late: "متأخر",
  absent: "غائب",
  on_leave: "إجازة معتمدة",
  incomplete: "بصمة ناقصة",
  holiday: "عطلة",
};

const LEAVE_STATUS_LABEL: Record<string, string> = {
  pending: "قيد المراجعة",
  under_review: "قيد المراجعة",
  approved: "معتمدة",
  rejected: "مرفوضة",
  cancelled: "ملغاة",
};

export default async function MyHrProfilePage() {
  const session = await requireSession();
  if (!session) redirect("/login");

  const summary = await getMyHrSummary(session);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 pb-24">
      <PageHeader
        title="ملفي الوظيفي"
        subtitle="بيانات العقد والدوام وسجل الحضور وأرصدة الإجازات الخاصة بحسابك"
      />

      {!summary.linked || !summary.staff ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xs">
          <p className="text-sm font-extrabold text-navy-900">
            لم يُربط هذا الحساب بملف وظيفي في شؤون الموظفين بعد
          </p>
          <p className="mt-1 text-xs text-slate-500">
            يمكن لإدارة المركز ربط حسابك بسجل الموظف من وحدة الموارد البشرية لعرض العقد والدوام وأرصدة الإجازات هنا.
          </p>
        </section>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
              <h2 className="mb-2 text-xs font-black text-slate-500">البطاقة الوظيفية</h2>
              <p className="text-base font-extrabold text-navy-900">{summary.staff.fullName}</p>
              <p className="mt-1 text-xs font-semibold text-slate-600">
                {summary.staff.jobTitle || "عضو طاقم"} {summary.staff.department ? `· ${summary.staff.department}` : ""}
              </p>
              {summary.staff.hireDate ? (
                <p className="mt-2 text-xs text-slate-500">
                  تاريخ المباشرة: <span className="font-bold text-slate-700">{friendlyDateLong(summary.staff.hireDate)}</span>
                </p>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
              <h2 className="mb-2 text-xs font-black text-slate-500">العقد الساري</h2>
              {summary.contract ? (
                <div className="space-y-1 text-xs">
                  <p className="text-sm font-extrabold text-navy-900">{summary.contract.title}</p>
                  <p className="text-slate-600">
                    رقم العقد: <bdi dir="ltr" className="font-mono font-bold">{summary.contract.contractNumber}</bdi>
                  </p>
                  {summary.contract.baseSalaryMinor !== null && summary.contract.salaryCurrency ? (
                    <p className="text-slate-700">
                      الأجر الأساسي:{" "}
                      <span className="font-extrabold text-navy-900">
                        {formatMoney(summary.contract.baseSalaryMinor, summary.contract.salaryCurrency as Currency)}
                      </span>
                    </p>
                  ) : null}
                  {summary.contract.commissionRatePercent !== null ? (
                    <p className="text-slate-700">
                      نسبة العمولة: <span className="font-extrabold text-navy-900">{summary.contract.commissionRatePercent}%</span>
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-slate-400">لا يوجد عقد معتمد مسجّل حاليًا.</p>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
            <h2 className="mb-3 text-sm font-extrabold text-navy-900">جدول الدوام المعتمد</h2>
            {summary.schedules.length === 0 ? (
              <p className="text-xs text-slate-400">لم يُحدد جدول دوام خاص بعد.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {summary.schedules.map((sch) => (
                  <div key={sch.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                    <p className="font-extrabold text-navy-900">{sch.name}</p>
                    <p className="mt-1 font-bold text-slate-700">
                      <bdi dir="ltr">{sch.shiftStartTime} – {sch.shiftEndTime}</bdi> · سماح {sch.gracePeriodMins} د
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      أيام العمل: {sch.workingDays.map((d) => DAY_NAMES[d] ?? d).join("، ") || "—"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
            <h2 className="mb-3 text-sm font-extrabold text-navy-900">أرصدة الإجازات السنوية والمرضية</h2>
            {summary.leaveBalances.length === 0 ? (
              <p className="text-xs text-slate-400">لا توجد أرصدة إجازات مخصّصة لهذه السنة بعد.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                {summary.leaveBalances.map((bal) => (
                  <div key={bal.leaveTypeCode} className="rounded-xl border border-slate-200 p-3 text-xs">
                    <p className="font-bold text-slate-600">{bal.leaveTypeName} ({bal.year})</p>
                    <p className="mt-1 text-lg font-black text-emerald-700">{bal.availableDays} يوم متاح</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      مخصّص: {bal.allocatedDays} · مستخدم: {bal.usedDays} · معلّق: {bal.pendingDays}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
            <h2 className="mb-3 text-sm font-extrabold text-navy-900">
              سجل الحضور والانصراف (<bdi dir="ltr">{summary.attendanceMonth}</bdi>)
            </h2>
            {summary.attendance.length === 0 ? (
              <p className="text-xs text-slate-400">لا توجد سجلات حضور مسجّلة لهذا الشهر بعد.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-slate-500">
                      <th className="px-3 py-2">التاريخ</th>
                      <th className="px-3 py-2">الحالة</th>
                      <th className="px-3 py-2">دقائق العمل</th>
                      <th className="px-3 py-2">تأخير</th>
                      <th className="px-3 py-2">إضافي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {summary.attendance.map((att) => (
                      <tr key={att.id}>
                        <td className="px-3 py-2 font-bold text-navy-900"><bdi dir="ltr">{att.attendanceDate}</bdi></td>
                        <td className="px-3 py-2 font-semibold text-slate-700">{ATT_STATUS_LABEL[att.status] ?? att.status}</td>
                        <td className="px-3 py-2">{att.workMinutes} د</td>
                        <td className="px-3 py-2 text-amber-700">{att.lateMinutes > 0 ? `${att.lateMinutes} د` : "—"}</td>
                        <td className="px-3 py-2 text-emerald-700">{att.overtimeMinutes > 0 ? `${att.overtimeMinutes} د` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {summary.leaveRequests.length > 0 ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
              <h2 className="mb-3 text-sm font-extrabold text-navy-900">طلبات الإجازة الأخيرة</h2>
              <ul className="divide-y divide-slate-100 text-xs">
                {summary.leaveRequests.map((req) => (
                  <li key={req.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <span className="font-bold text-navy-900">{req.leaveTypeName}</span>
                      <span className="mx-1.5 text-slate-400">·</span>
                      <bdi dir="ltr" className="text-slate-600">{req.startDate} → {req.endDate}</bdi>
                      <span className="mr-1.5 text-slate-500">({req.daysCount} يوم)</span>
                    </div>
                    <span className="rounded-lg bg-slate-100 px-2.5 py-0.5 font-bold text-slate-700">
                      {LEAVE_STATUS_LABEL[req.status] ?? req.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
