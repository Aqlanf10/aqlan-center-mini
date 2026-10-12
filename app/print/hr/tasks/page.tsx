import { canUseTasks, listTasks } from "@/lib/hr";
import { requireSession } from "@/lib/session";
import { getSettingsSafe } from "@/lib/db";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, canAssignTasks, type TaskStatus } from "@/lib/hr";

export const dynamic = "force-dynamic";

const STATUS_ORDER: TaskStatus[] = ["planned", "in_progress", "blocked", "completed", "cancelled"];

/**
 * كشف المهام — ملف طباعةٍ مستقل بشرط رؤية القارئ نفسه الذي يحكم الشاشة:
 * الخاصة لصاحبها وحده حتى على الورق، والمشتركة للإدارة المخولة. بياناته
 * مهامٌ بحالتها ومدة تأخرها — لا مبالغ ولا عملات هنا.
 */
export default async function HrTasksPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; overdue?: string | string[]; scope?: string | string[] }>;
}) {
  const session = await requireSession();
  if (!session || !canUseTasks(session.role)) {
    return <p className="p-6 text-sm">كشف المهام للمخوّلين به فقط.</p>;
  }
  const params = await searchParams;
  const statusParam = typeof params.status === "string" ? params.status : undefined;
  const overdueOnly = params.overdue === "1";
  const scope = params.scope === "mine" ? "mine" : canAssignTasks(session.role) ? "team" : "mine";

  const payload = await listTasks(session, {
    status: statusParam && STATUS_ORDER.includes(statusParam as TaskStatus) ? (statusParam as TaskStatus) : null,
    overdueOnly,
    scope,
  });
  const settings = await getSettingsSafe();

  return (
    <div className="print-sheet hr-tasks-sheet" dir="rtl">
      <PrintHeader settings={settings} title="كشف المهام" />
      <p className="report-meta">
        صادر بتاريخ {friendlyDateLong(new Date().toISOString())} — النطاق: {scope === "mine" ? "مهامي" : "متابعة الفريق"} —
        عدد المهام الظاهرة: {payload.tasks.length} — المتأخرات: {payload.overdueCount}
      </p>

      <table className="report-table hr-tasks-table">
        <thead>
          <tr>
            <th>#</th>
            <th>المهمة</th>
            <th>الحالة</th>
            <th>الأولوية</th>
            <th>المسؤول</th>
            <th>صاحبها</th>
            <th>التخطيط</th>
            <th>الاستحقاق</th>
            <th>التأخر</th>
            <th>الخصوصية</th>
          </tr>
        </thead>
        <tbody>
          {payload.tasks.map((task, index) => {
            const overdueDays = task.overdueDays > 0 ? task.overdueDays : null;
            return (
              <tr key={task.id}>
                <td className="num">{index + 1}</td>
                <td>{task.title}</td>
                <td>{TASK_STATUS_LABEL[task.status]}</td>
                <td>{TASK_PRIORITY_LABEL[task.priority]}</td>
                <td>{task.assigneeLabel || "—"}</td>
                <td>{task.ownerDisplayName}</td>
                <td className="num">{task.plannedFor ?? "—"}</td>
                <td className="num">{task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : "—"}</td>
                <td className="num">{overdueDays !== null ? `${overdueDays} يومًا` : "—"}</td>
                <td>{task.isPrivate ? "خاصة" : "مشتركة"}</td>
              </tr>
            );
          })}
          {payload.tasks.length === 0 && (
            <tr><td colSpan={10} className="empty">لا مهام مطابقة.</td></tr>
          )}
        </tbody>
      </table>

      <section className="hr-salary-summary">
        <h3>الملخص بحالة كل مهمة</h3>
        <ul>
          {STATUS_ORDER.map((status) => (
            <li key={status}>{TASK_STATUS_LABEL[status]}: {payload.counts[status]}</li>
          ))}
        </ul>
      </section>

      <PrintFooter settings={settings} />
      <PrintButton />
    </div>
  );
}
