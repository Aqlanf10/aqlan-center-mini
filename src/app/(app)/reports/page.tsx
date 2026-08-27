import Link from "next/link";
import {
  CalendarCheckIcon,
  CalendarXIcon,
  FileBarChartIcon,
  PhoneCallIcon,
  UserRoundPlusIcon,
  UsersRoundIcon,
  UserRoundXIcon,
} from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { PageHeader } from "@/components/shared/page-header";
import { getOwnerReport, resolveReportRange } from "@/server/reports/queries";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const PRESETS = [
  { value: "today", labelKey: "today" },
  { value: "last7days", labelKey: "last7days" },
  { value: "thisMonth", labelKey: "thisMonth" },
  { value: "custom", labelKey: "custom" },
] as const;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/reports");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const presetParam = single(params.preset);
  const range = resolveReportRange({
    preset: presetParam,
    from: single(params.from),
    to: single(params.to),
  });
  const report = await getOwnerReport(range);

  const rangeLabel =
    range.preset === "custom"
      ? `${formatZonedDate(range.startUtc, locale)} — ${formatZonedDate(
          new Date(range.endUtc.getTime() - 1),
          locale
        )}`
      : dict.reports.presets[range.preset];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={dict.reports.title}
        subtitle={dict.reports.subtitle.replace("{range}", rangeLabel)}
      />

      {/* Filters (GET form — read-only page, no mutations) */}
      <form
        method="get"
        className="border-muted flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
        <noscript>
          <button type="submit" className="sr-only">
            apply
          </button>
        </noscript>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-muted-foreground text-xs">
            {dict.reports.filterLabel}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => {
              const active = range.preset === preset.value;
              return (
                <Link
                  key={preset.value}
                  href={preset.value === "custom" ? "/reports?preset=custom" : `/reports?preset=${preset.value}`}
                  className={
                    active
                      ? "bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium"
                      : "border-muted hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
                  }
                >
                  {dict.reports.presets[preset.labelKey]}
                </Link>
              );
            })}
          </div>
        </fieldset>
        {range.preset === "custom" ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{dict.reports.fromDate}</span>
              <input
                type="date"
                name="from"
                defaultValue={single(params.from) ?? ""}
                required
                className="border-muted rounded-md border px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{dict.reports.toDate}</span>
              <input
                type="date"
                name="to"
                defaultValue={single(params.to) ?? ""}
                required
                className="border-muted rounded-md border px-2 py-1.5 text-sm"
              />
            </label>
            <input type="hidden" name="preset" value="custom" />
            <button
              type="submit"
              className="bg-primary text-primary-foreground h-9 rounded-md px-3 text-sm font-medium"
            >
              {dict.reports.apply}
            </button>
          </div>
        ) : null}
      </form>

      {/* A) Patients */}
      <section aria-label={dict.reports.patients.title} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.reports.patients.title}</h2>
        <div className="grid grid-cols-2 gap-2">
          <StatCard
            label={dict.reports.patients.newPatients}
            value={String(report.patients.newPatients)}
            icon={<UserRoundPlusIcon className="size-4" aria-hidden="true" />}
            href="/patients?created=this_month"
          />
          <StatCard
            label={dict.reports.patients.activePatients}
            value={String(report.patients.activePatients)}
            icon={<UsersRoundIcon className="size-4" aria-hidden="true" />}
            href="/patients?filter=active"
          />
        </div>
      </section>

      {/* B) Appointments */}
      <section aria-label={dict.reports.appointments.title} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.reports.appointments.title}</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatCard
            label={dict.reports.appointments.total}
            value={String(report.appointments.total)}
            icon={<FileBarChartIcon className="size-4" aria-hidden="true" />}
            href="/appointments"
          />
          <StatCard
            label={dict.reports.appointments.completed}
            value={String(report.appointments.completed)}
            tone="success"
            icon={<CalendarCheckIcon className="size-4" aria-hidden="true" />}
            href="/appointments"
          />
          <StatCard
            label={dict.reports.appointments.cancelled}
            value={String(report.appointments.cancelled)}
            tone="danger"
            icon={<CalendarXIcon className="size-4" aria-hidden="true" />}
            href="/appointments"
          />
          <StatCard
            label={dict.reports.appointments.noShow}
            value={String(report.appointments.noShow)}
            tone="danger"
            icon={<UserRoundXIcon className="size-4" aria-hidden="true" />}
            href="/follow-up?queue=missed"
          />
        </div>
      </section>

      {/* C) Follow-up */}
      <section aria-label={dict.reports.followUp.title} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.reports.followUp.title}</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatCard
            label={dict.reports.followUp.overdue}
            value={String(report.followUp.overdue)}
            tone="danger"
            href="/follow-up?queue=overdue"
          />
          <StatCard
            label={dict.reports.followUp.noNextAppointment}
            value={String(report.followUp.noNextAppointment)}
            href="/follow-up?queue=no-next-appointment"
          />
          <StatCard
            label={dict.reports.followUp.missed}
            value={String(report.followUp.missed)}
            tone="danger"
            href="/follow-up?queue=missed"
          />
          <StatCard
            label={dict.reports.followUp.contacted}
            value={String(report.contacts.contactedInRange)}
            tone="success"
            icon={<PhoneCallIcon className="size-4" aria-hidden="true" />}
            href="/follow-up?queue=contacted"
          />
        </div>
      </section>

      {/* D) Finance — per currency, never mixed */}
      <section aria-label={dict.reports.finance.title} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.reports.finance.title}</h2>
        <div className="border-muted overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.reports.finance.row}
                </th>
                <th className="px-3 py-2 text-end font-medium" scope="col">YER</th>
                <th className="px-3 py-2 text-end font-medium" scope="col">USD</th>
                <th className="px-3 py-2 text-end font-medium" scope="col">SAR</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-muted border-t">
                <td className="px-3 py-2">{dict.reports.finance.charges}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{report.finance.charges.YER}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{report.finance.charges.USD}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{report.finance.charges.SAR}</td>
              </tr>
              <tr className="border-muted border-t">
                <td className="px-3 py-2">{dict.reports.finance.payments}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{report.finance.payments.YER}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{report.finance.payments.USD}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{report.finance.payments.SAR}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* E) Doctor activity */}
      <section aria-label={dict.reports.doctors.title} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.reports.doctors.title}</h2>
        <div className="border-muted overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.reports.doctors.doctor}
                </th>
                <th className="px-3 py-2 text-end font-medium" scope="col">
                  {dict.reports.doctors.appointments}
                </th>
                <th className="px-3 py-2 text-end font-medium" scope="col">
                  {dict.reports.doctors.completedVisits}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.doctorActivity.length === 0 ? (
                <tr className="border-muted border-t">
                  <td className="text-muted-foreground px-3 py-3" colSpan={3}>
                    {dict.reports.doctors.empty}
                  </td>
                </tr>
              ) : (
                report.doctorActivity.map((row) => (
                  <tr key={row.doctorId} className="border-muted border-t">
                    <td className="px-3 py-2" dir="auto">{row.doctorName}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{row.appointmentsCount}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{row.completedVisitsCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-muted-foreground text-xs">
        {dict.reports.readOnlyNote} · {dict.reports.rangeLabel}: {rangeLabel}
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  tone?: "neutral" | "warning" | "info" | "success" | "danger";
  href: string;
}) {
  const toneClasses: Record<string, string> = {
    neutral: "text-foreground",
    warning: "text-amber-600 dark:text-amber-400",
    info: "text-sky-600 dark:text-sky-400",
    success: "text-emerald-600 dark:text-emerald-400",
    danger: "text-red-600 dark:text-red-400",
  };
  return (
    <Link
      href={href}
      className="border-muted hover:border-primary/40 rounded-lg border p-3 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClasses[tone]}`}>
        {value}
      </p>
    </Link>
  );
}
