import Link from "next/link";
import { BellRingIcon, MessageCircleIcon, PhoneIcon } from "lucide-react";

import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate, getTodayIsoDate } from "@/lib/datetime";
import { buildWhatsAppLink } from "@/lib/whatsapp";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import {
  ContactResultBadge,
  FollowUpStatusBadge,
} from "@/components/shared/status-badges";
import { ContactDialog } from "@/components/contacts/contact-dialog";
import { AppointmentFormDialog } from "@/components/appointments/appointment-form-dialog";
import {
  deriveFollowUpEntries,
  filterByQueue,
  getFollowUpCandidates,
  getRecentContacts,
} from "@/server/follow-up/queries";
import { isFollowUpQueue, type FollowUpQueue } from "@/server/follow-up/logic";
import { listDoctors } from "@/server/appointments/queries";
import { formatZonedDateTime } from "@/lib/datetime";
import type { ContactType } from "@/db/schema/enums";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function FollowUpPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireUser("/follow-up");
  const { locale, dict } = await getI18n();
  const params = await searchParams;
  const rawQueue = Array.isArray(params.queue) ? params.queue[0] : params.queue;
  const queue: FollowUpQueue = isFollowUpQueue(rawQueue) ? rawQueue : "overdue";

  const doctors = await listDoctors();

  const queueLabels: Record<FollowUpQueue, string> = {
    "due-today": dict.followUp.queues.dueToday,
    "due-soon": dict.followUp.queues.dueSoon,
    overdue: dict.followUp.queues.overdue,
    "no-next-appointment": dict.followUp.queues.noNextAppointment,
    missed: dict.followUp.queues.missedAppointments,
    contacted: dict.followUp.queues.contacted,
  };

  const queueOrder: FollowUpQueue[] = [
    "due-today",
    "due-soon",
    "overdue",
    "no-next-appointment",
    "missed",
    "contacted",
  ];

  let entries: Awaited<ReturnType<typeof deriveFollowUpEntries>> = [];
  let contacted: Awaited<ReturnType<typeof getRecentContacts>> = [];

  if (queue === "contacted") {
    contacted = await getRecentContacts();
  } else {
    const candidates = await getFollowUpCandidates();
    entries = filterByQueue(deriveFollowUpEntries(candidates), queue);
    // Most urgent first for recall queues: oldest reference date on top.
    entries.sort((a, b) => {
      const aDate = a.assessment.referenceDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bDate = b.assessment.referenceDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aDate - bDate;
    });
  }

  const todayIso = getTodayIsoDate();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={dict.followUp.title} subtitle={dict.followUp.subtitle} />

      {/* Queue tabs (URL-driven) */}
      <nav
        className="border-muted -mx-1 flex gap-1 overflow-x-auto border-b px-1 pb-px"
        aria-label={dict.followUp.title}
      >
        {queueOrder.map((q) => (
          <Link
            key={q}
            href={`/follow-up?queue=${q}`}
            className={`rounded-t-md px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
              queue === q
                ? "border-muted border border-b-transparent bg-background font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-current={queue === q ? "page" : undefined}
          >
            {queueLabels[q]}
          </Link>
        ))}
      </nav>

      {queue === "contacted" ? (
        contacted.length === 0 ? (
          <EmptyState
            icon={MessageCircleIcon}
            title={dict.followUp.contactHistory.empty}
            description={dict.followUp.actions.markContacted}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {contacted.map((row) => (
              <li
                key={row.id}
                className="border-muted flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/patients/${row.patientId}`}
                      className="hover:text-primary font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {row.patientName}
                    </Link>
                    <ContactResultBadge result={row.result} dict={dict} />
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-sm">
                    {dict.statuses.contactType[row.contactType as ContactType]}
                    {row.note ? ` · ${row.note}` : ""}
                  </p>
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatZonedDateTime(new Date(row.contactedAt), locale)} ·{" "}
                  {row.byName}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : entries.length === 0 ? (
        <EmptyState
          icon={BellRingIcon}
          title={dict.followUp.emptyQueue}
          description={queueLabels[queue]}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const whatsappLink = buildWhatsAppLink(
              entry.mobile,
              dict.followUp.whatsappMessage
                .replace("{name}", entry.fullName)
                .replace("{center}", dict.app.centerName)
            );
            const overdueDays = entry.assessment.recallDueIsoDate
              ? daysBetween(entry.assessment.recallDueIsoDate, todayIso)
              : null;
            return (
              <li key={entry.patientId} className="border-muted rounded-lg border p-3">
                {/* Mobile-first card */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/patients/${entry.patientId}`}
                        className="hover:text-primary font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {entry.fullName}
                      </Link>
                      <FollowUpStatusBadge
                        status={entry.assessment.status}
                        dict={dict}
                      />
                    </div>
                    <p className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-sm">
                      <span className="font-mono text-xs" dir="ltr">
                        {entry.fileNumber}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span dir="ltr">{entry.mobile}</span>
                      {entry.lastCompletedVisitDate ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {dict.followUp.columns.lastVisit}:{" "}
                            {formatZonedDate(
                              new Date(entry.lastCompletedVisitDate),
                              locale
                            )}
                          </span>
                        </>
                      ) : null}
                      {queue === "missed" && entry.lastNoShowDate ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {dict.followUp.columns.noShowDate}:{" "}
                            {formatZonedDate(new Date(entry.lastNoShowDate), locale)}
                          </span>
                        </>
                      ) : null}
                      {entry.assessment.recallDueIsoDate ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {dict.followUp.columns.recallDue}:{" "}
                            {entry.assessment.recallDueIsoDate}
                            {overdueDays !== null && overdueDays > 0
                              ? ` (${dict.followUp.overdueBy.replace("{count}", String(overdueDays))})`
                              : ""}
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>

                  {/* Actions: WhatsApp, Call, Log contact, Reschedule */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <a
                      href={`tel:${entry.mobile}`}
                      className="hover:bg-accent inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <PhoneIcon className="size-3.5" aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only">
                        {dict.followUp.actions.call}
                      </span>
                    </a>
                    {whatsappLink ? (
                      <a
                        href={whatsappLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:bg-accent inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <MessageCircleIcon className="size-3.5" aria-hidden="true" />
                        <span className="sr-only sm:not-sr-only">
                          {dict.followUp.actions.whatsapp}
                        </span>
                      </a>
                    ) : null}
                    <ContactDialog
                      patientId={entry.patientId}
                      patientName={entry.fullName}
                      trigger={dict.followUp.actions.markContacted}
                      triggerVariant="outline"
                    />
                    <AppointmentFormDialog
                      doctors={doctors}
                      patient={{
                        id: entry.patientId,
                        fullName: entry.fullName,
                        fileNumber: entry.fileNumber,
                      }}
                      trigger={dict.followUp.actions.reschedule}
                      triggerVariant="secondary"
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}
