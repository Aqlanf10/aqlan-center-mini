import Link from "next/link";
import { CalendarClockIcon, StethoscopeIcon } from "lucide-react";

import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import {
  formatZonedDate,
  formatZonedTime,
} from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { AppointmentStatusBadge } from "@/components/shared/status-badges";
import { AppointmentFormDialog } from "@/components/appointments/appointment-form-dialog";
import { AppointmentQuickActions } from "@/components/appointments/quick-actions";
import { getTodayAppointments, listDoctors } from "@/server/appointments/queries";
import { getTodayWorkSummary } from "@/server/services/work-items";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const user = await requireUser("/today");
  const { locale, dict } = await getI18n();

  const [rows, doctors] = await Promise.all([
    getTodayAppointments(),
    listDoctors(),
  ]);

  // Completed work today (from real work items; DOCTOR sees own only).
  const workSummary = await getTodayWorkSummary(
    user.role === "DOCTOR" ? { doctorId: user.id } : undefined
  );


  const counts = {
    waiting: rows.filter((row) => row.status === "ARRIVED").length,
    inTreatment: rows.filter((row) => row.status === "IN_TREATMENT").length,
    completed: rows.filter((row) => row.status === "COMPLETED").length,
    noShow: rows.filter((row) => row.status === "NO_SHOW").length,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={dict.today.title}
        subtitle={dict.today.clinicDate.replace(
          "{date}",
          formatZonedDate(new Date(), locale)
        )}
        actions={
          <AppointmentFormDialog
            doctors={doctors}
            trigger={dict.today.createAppointment}
          />
        }
      />

      {/* Operational counters — computed from the DB, never faked */}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CounterCard label={dict.today.counts.total.replace("{count}", String(rows.length))} />
        <CounterCard label={dict.today.counts.waiting} value={counts.waiting} tone="warning" />
        <CounterCard label={dict.today.counts.inTreatment} value={counts.inTreatment} tone="info" />
        <CounterCard label={dict.today.counts.completed} value={counts.completed} tone="success" />
        <CounterCard label={dict.today.counts.noShow} value={counts.noShow} tone="danger" />
      </dl>

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarClockIcon}
          title={dict.today.emptyTitle}
          description={dict.today.emptyHint}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="border-muted rounded-lg border p-3 sm:p-4"
            >
              {/* Mobile-first card layout; time rail works on desktop too */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex min-w-20 flex-col">
                  <span className="text-lg font-semibold tabular-nums" dir="ltr">
                    {formatZonedTime(new Date(row.appointmentDate), locale)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatZonedDate(new Date(row.appointmentDate), locale)}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/patients/${row.patientId}`}
                      className="hover:text-primary font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {row.patientName}
                    </Link>
                    <AppointmentStatusBadge status={row.status} dict={dict} />
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-sm">
                    <span className="font-mono text-xs" dir="ltr">
                      {row.fileNumber}
                    </span>
                    {" · "}
                    {row.doctorName}
                    {row.reason ? ` · ${row.reason}` : ""}
                  </p>
                </div>

                <div className="sm:w-auto">
                  <AppointmentQuickActions
                    appointment={{
                      id: row.id,
                      patientId: row.patientId,
                      patientName: row.patientName,
                      fileNumber: row.fileNumber,
                      status: row.status,
                      doctorId: row.doctorId,
                      appointmentDate: new Date(row.appointmentDate),
                      reason: row.reason,
                    }}
                    doctors={doctors}
                    compact
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Completed work today — by service, doctor and currency */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{dict.todayWork.title}</h2>
            <p className="text-muted-foreground text-sm">{dict.todayWork.subtitle}</p>
          </div>
          {user.role === "ADMIN" ? (
            <Link
              href="/reports/daily-work"
              className="text-primary text-sm font-medium hover:underline"
            >
              {dict.todayWork.todayWorkReport}
            </Link>
          ) : null}
        </div>
        {workSummary.length === 0 ? (
          <EmptyState
            icon={StethoscopeIcon}
            title={dict.todayWork.empty}
            description={dict.todayWork.emptyHint}
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.service}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.doctor}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.count}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.total}
                  </th>
                </tr>
              </thead>
              <tbody>
                {workSummary.map((row) => (
                  <tr key={row.key} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-medium">
                      {locale === "ar" ? row.serviceNameAr : row.serviceNameEn}
                    </td>
                    <td className="px-3 py-2.5">{row.doctorName}</td>
                    <td className="px-3 py-2.5">{row.count}</td>
                    <td className="px-3 py-2.5 font-semibold" dir="ltr">
                      {formatMoney(row.totalMinor, row.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}

function CounterCard({
  label,
  value,
  tone = "neutral",
  className,
}: {
  label: string;
  value?: number;
  tone?: "neutral" | "warning" | "info" | "success" | "danger";
  className?: string;
}) {
  const toneClasses: Record<string, string> = {
    neutral: "text-foreground",
    warning: "text-amber-600 dark:text-amber-400",
    info: "text-sky-600 dark:text-sky-400",
    success: "text-emerald-600 dark:text-emerald-400",
    danger: "text-red-600 dark:text-red-400",
  };
  return (
    <div
      className={`border-muted rounded-lg border px-3 py-2 ${className ?? ""}`}
    >
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${toneClasses[tone]}`}>
        {value ?? 0}
      </dd>
    </div>
  );
}
