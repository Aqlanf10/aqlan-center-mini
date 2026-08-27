import Link from "next/link";
import {
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  CircleCheckIcon,
  ClockIcon,
  CoinsIcon,
  StethoscopeIcon,
  UserRoundXIcon,
  UsersRoundIcon,
} from "lucide-react";

import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import {
  getNewPatientsThisMonth,
  getTodayFinanceByCurrency,
  getTodayMetrics,
} from "@/server/dashboard/queries";
import {
  getActivePatientCount,
  getFollowUpCounts,
} from "@/server/follow-up/queries";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser("/dashboard");
  const { dict } = await getI18n();

  // All metrics are computed from the database — no placeholders, ever.
  const [metrics, followUp, activePatients, newPatients, todayFinance] =
    await Promise.all([
      getTodayMetrics(),
      getFollowUpCounts(),
      getActivePatientCount(),
      getNewPatientsThisMonth(),
      // Finance cards are ADMIN-only data; avoid the queries for other roles.
      user.role === "ADMIN" ? getTodayFinanceByCurrency() : null,
    ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">
          {dict.dashboard.welcome.replace("{name}", user.name)}
        </h1>
        <p className="text-muted-foreground mt-1">{dict.dashboard.welcomeSubtitle}</p>
      </header>

      {/* Today's operational metrics */}
      <section aria-label={dict.dashboard.metricsTitle} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.dashboard.metricsTitle}</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <MetricCard
            href="/today"
            label={dict.dashboard.metrics.todayAppointments}
            value={metrics.todayAppointments}
            icon={<CalendarClockIcon className="size-4" aria-hidden="true" />}
          />
          <MetricCard
            href="/today"
            label={dict.dashboard.metrics.waiting}
            value={metrics.waiting}
            tone="warning"
            icon={<ClockIcon className="size-4" aria-hidden="true" />}
          />
          <MetricCard
            href="/today"
            label={dict.dashboard.metrics.inTreatment}
            value={metrics.inTreatment}
            tone="info"
            icon={<StethoscopeIcon className="size-4" aria-hidden="true" />}
          />
          <MetricCard
            href="/today"
            label={dict.dashboard.metrics.completedToday}
            value={metrics.completedToday}
            tone="success"
            icon={<CircleCheckIcon className="size-4" aria-hidden="true" />}
          />
          <MetricCard
            href="/today"
            label={dict.dashboard.metrics.noShowsToday}
            value={metrics.noShowsToday}
            tone="danger"
            icon={<UserRoundXIcon className="size-4" aria-hidden="true" />}
          />
        </div>
      </section>

      {/* Follow-up queues */}
      <section aria-label={dict.dashboard.followUpTitle} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.dashboard.followUpTitle}</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <MetricCard
            href="/follow-up?queue=due-today"
            label={dict.followUp.queues.dueToday}
            value={followUp.dueToday}
            tone="warning"
          />
          <MetricCard
            href="/follow-up?queue=due-soon"
            label={dict.followUp.queues.dueSoon}
            value={followUp.dueSoon}
            tone="warning"
          />
          <MetricCard
            href="/follow-up?queue=overdue"
            label={dict.dashboard.metrics.overdue}
            value={followUp.overdue}
            tone="danger"
          />
          <MetricCard
            href="/follow-up?queue=no-next-appointment"
            label={dict.dashboard.metrics.noNextAppointment}
            value={followUp.noNextAppointment}
            tone="info"
          />
          <MetricCard
            href="/follow-up?queue=missed"
            label={dict.followUp.queues.missedAppointments}
            value={followUp.missed}
            tone="danger"
          />
        </div>
      </section>

      {/* Patients */}
      <section aria-label={dict.dashboard.patientsTitle} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.dashboard.patientsTitle}</h2>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard
            href="/patients?filter=active"
            label={dict.dashboard.metrics.activePatients}
            value={activePatients}
            icon={<UsersRoundIcon className="size-4" aria-hidden="true" />}
          />
          <MetricCard
            href="/patients?created=this_month"
            label={dict.dashboard.metrics.newPatientsThisMonth}
            value={newPatients}
            tone="success"
            icon={<CalendarPlusIcon className="size-4" aria-hidden="true" />}
          />
        </div>
      </section>

      {/* Finance (ADMIN only) — per currency, never mixed */}
      {user.role === "ADMIN" && todayFinance ? (
        <section aria-label={dict.dashboard.financeTitle} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">{dict.dashboard.financeTitle}</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <FinanceCard
              href="/reports"
              title={dict.dashboard.metrics.todayCharges}
              totals={todayFinance.charges}
            />
            <FinanceCard
              href="/reports"
              title={dict.dashboard.metrics.todayCollections}
              totals={todayFinance.payments}
              tone="success"
            />
          </div>
        </section>
      ) : null}

      {/* Quick links */}
      <section aria-label={dict.dashboard.quickLinksTitle} className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{dict.dashboard.quickLinksTitle}</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <QuickLink
            href="/today"
            label={dict.dashboard.viewToday}
            icon={<CalendarCheckIcon className="size-4" aria-hidden="true" />}
          />
          <QuickLink
            href="/patients"
            label={dict.dashboard.viewPatients}
            icon={<UsersRoundIcon className="size-4" aria-hidden="true" />}
            badge={activePatients}
          />
          <QuickLink
            href="/appointments"
            label={dict.dashboard.viewAppointments}
            icon={<CalendarClockIcon className="size-4" aria-hidden="true" />}
          />
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  href,
  label,
  value,
  icon,
  tone = "neutral",
}: {
  href: string;
  label: string;
  value: number;
  icon?: React.ReactNode;
  tone?: "neutral" | "warning" | "info" | "success" | "danger";
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

function FinanceCard({
  href,
  title,
  totals,
  tone = "neutral",
}: {
  href: string;
  title: string;
  totals: { YER: string; USD: string; SAR: string };
  tone?: "neutral" | "success";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-foreground";
  return (
    <Link
      href={href}
      className="border-muted hover:border-primary/40 flex flex-col gap-1.5 rounded-lg border p-3 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <CoinsIcon className="size-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <ul className={`flex flex-col text-sm font-semibold tabular-nums ${toneClass}`}>
        <li className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs font-normal">YER</span>
          <span dir="ltr">{totals.YER}</span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs font-normal">USD</span>
          <span dir="ltr">{totals.USD}</span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs font-normal">SAR</span>
          <span dir="ltr">{totals.SAR}</span>
        </li>
      </ul>
    </Link>
  );
}

function QuickLink({
  href,
  label,
  icon,
  badge,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="border-muted hover:border-primary/40 flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      {badge !== undefined ? (
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs tabular-nums">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
