import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRightIcon,
  CalendarPlusIcon,
  PhoneIcon,
  StethoscopeIcon,
  MessageCircleIcon,
} from "lucide-react";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { patientContacts, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import {
  formatZonedDate,
  formatZonedDateTime,
  getTodayIsoDate,
} from "@/lib/datetime";
import { buildWhatsAppLink } from "@/lib/whatsapp";
import { EmptyState } from "@/components/shared/empty-state";
import {
  ActiveBadge,
  AppointmentStatusBadge,
  ContactResultBadge,
  FollowUpStatusBadge,
  TreatmentStatusBadge,
  VisitStatusBadge,
} from "@/components/shared/status-badges";
import { AppointmentFormDialog } from "@/components/appointments/appointment-form-dialog";
import { AppointmentQuickActions } from "@/components/appointments/quick-actions";
import { PatientFormDialog } from "@/components/patients/patient-form-dialog";
import { ArchivePatientButton } from "@/components/patients/archive-button";
import { NewVisitButton } from "@/components/patients/new-visit-button";
import { PatientFinanceSection } from "@/components/finance/patient-finance";
import { getPatientById, getPatientSummary } from "@/server/patients/queries";
import {
  getPatientAppointments,
  listDoctors,
} from "@/server/appointments/queries";
import { getPatientVisits } from "@/server/visits/queries";
import { assessFollowUp } from "@/server/follow-up/logic";

export const dynamic = "force-dynamic";

const TABS = [
  "overview",
  "appointments",
  "visits",
  "contacts",
  "treatment",
  "payments",
] as const;
type Tab = (typeof TABS)[number];

export default async function PatientProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("/patients");
  const { locale, dict } = await getI18n();
  const { id } = await params;
  const tabParam = await searchParams;
  const rawTab = Array.isArray(tabParam.tab) ? tabParam.tab[0] : tabParam.tab;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : "overview";

  const record = await getPatientById(id);
  if (!record) {
    notFound();
  }
  const { patient, doctorName } = record;

  const [summary, doctors, appointmentRows, visitRows, contactRows] =
    await Promise.all([
      getPatientSummary(id),
      listDoctors(),
      getPatientAppointments(id),
      getPatientVisits(id),
      db
        .select({
          id: patientContacts.id,
          contactType: patientContacts.contactType,
          result: patientContacts.result,
          note: patientContacts.note,
          contactedAt: patientContacts.contactedAt,
          byName: users.name,
        })
        .from(patientContacts)
        .innerJoin(users, eq(patientContacts.userId, users.id))
        .where(eq(patientContacts.patientId, id))
        .orderBy(desc(patientContacts.contactedAt))
        .limit(20),
    ]);

  const assessment = assessFollowUp({
    active: patient.active,
    treatmentStatus: patient.treatmentStatus,
    todayIso: getTodayIsoDate(),
    nextAppointmentDate: summary.nextAppointmentDate
      ? new Date(summary.nextAppointmentDate)
      : null,
    lastCompletedVisitDate: summary.lastCompletedVisitDate
      ? new Date(summary.lastCompletedVisitDate)
      : null,
    recallIntervalDays: patient.recallIntervalDays,
    lastNoShowDate: null,
  });

  const whatsappLink = buildWhatsAppLink(
    patient.mobile,
    dict.followUp.whatsappMessage
      .replace("{name}", patient.fullName)
      .replace("{center}", dict.app.centerName)
  );

  const tabHref = (target: Tab) => `/patients/${id}?tab=${target}`;

  const tabLabels: Record<Tab, string> = {
    overview: dict.patients.profile.tabs.overview,
    appointments: dict.patients.profile.tabs.appointments,
    visits: dict.patients.profile.tabs.visits,
    contacts: dict.patients.profile.tabs.contacts,
    treatment: dict.patients.profile.tabs.treatment,
    payments: dict.patients.profile.tabs.payments,
  };


  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link
          href="/patients"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowRightIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
          {dict.patients.profile.backToList}
        </Link>

        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{patient.fullName}</h1>
              <TreatmentStatusBadge status={patient.treatmentStatus} dict={dict} />
              {!patient.active ? <ActiveBadge active={false} dict={dict} /> : null}
            </div>
            <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-mono" dir="ltr">
                {patient.fileNumber}
              </span>
              <span aria-hidden="true">·</span>
              <span dir="ltr">{patient.mobile}</span>
              <span aria-hidden="true">·</span>
              <span>{doctorName ?? dict.patients.fields.noDoctor}</span>
              {patient.treatmentType ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{patient.treatmentType}</span>
                </>
              ) : null}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {patient.active ? (
              <>
                <AppointmentFormDialog
                  doctors={doctors}
                  patient={{
                    id: patient.id,
                    fullName: patient.fullName,
                    fileNumber: patient.fileNumber,
                  }}
                  trigger={dict.patients.profile.newAppointment}
                />
                {user.role !== "RECEPTION" ? (
                  <NewVisitButton
                    patientId={patient.id}
                    doctors={doctors}
                    label={dict.patients.profile.newVisit}
                  />
                ) : null}
              </>
            ) : null}
            <PatientFormDialog
              doctors={doctors}
              patient={{
                id: patient.id,
                values: {
                  fullName: patient.fullName,
                  gender: patient.gender,
                  dateOfBirth: patient.dateOfBirth ?? "",
                  mobile: patient.mobile,
                  alternateMobile: patient.alternateMobile ?? "",
                  address: patient.address ?? "",
                  treatingDoctorId: patient.treatingDoctorId ?? "",
                  treatmentType: patient.treatmentType ?? "",
                  treatmentStatus: patient.treatmentStatus,
                  recallIntervalDays: patient.recallIntervalDays,
                  notes: patient.notes ?? "",
                },
              }}
              trigger={dict.common.edit}
              triggerVariant="outline"
            />
            <ArchivePatientButton
              patientId={patient.id}
              active={patient.active}
              name={patient.fullName}
            />
          </div>
        </div>
      </div>

      {/* Operational summary */}
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryCard label={dict.patients.profile.summary.lastVisit}>
          {summary.lastCompletedVisitDate ? (
            formatZonedDate(new Date(summary.lastCompletedVisitDate), locale)
          ) : (
            <span className="text-muted-foreground">
              {dict.patients.profile.summary.never}
            </span>
          )}
        </SummaryCard>
        <SummaryCard label={dict.patients.profile.summary.nextAppointment}>
          {summary.nextAppointmentDate ? (
            formatZonedDateTime(new Date(summary.nextAppointmentDate), locale)
          ) : (
            <span className="text-muted-foreground">
              {dict.patients.profile.summary.none}
            </span>
          )}
        </SummaryCard>
        <SummaryCard label={dict.patients.profile.summary.daysSinceLastVisit}>
          {assessment.daysSinceLastVisit !== null ? (
            <span className="tabular-nums">{assessment.daysSinceLastVisit}</span>
          ) : (
            <span className="text-muted-foreground">
              {dict.patients.profile.summary.never}
            </span>
          )}
        </SummaryCard>
        <SummaryCard label={dict.patients.profile.summary.followUpStatus}>
          <FollowUpStatusBadge status={assessment.status} dict={dict} />
        </SummaryCard>
      </section>

      {/* Contact shortcuts */}
      <div className="flex flex-wrap gap-2">
        <a
          href={`tel:${patient.mobile}`}
          className="hover:bg-accent inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <PhoneIcon className="size-4" aria-hidden="true" />
          {dict.followUp.actions.call}
        </a>
        {whatsappLink ? (
          <a
            href={whatsappLink}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:bg-accent inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <MessageCircleIcon className="size-4" aria-hidden="true" />
            {dict.followUp.actions.whatsapp}
          </a>
        ) : null}
      </div>

      {/* Tabs (URL-driven, server-rendered) */}
      <nav
        className="border-muted -mx-1 flex gap-1 overflow-x-auto border-b px-1 pb-px"
        aria-label={dict.appointments.title}
      >
        {TABS.map((t) => (
          <Link
            key={t}
            href={tabHref(t)}
            className={`rounded-t-md px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
              tab === t
                ? "border-muted border border-b-transparent bg-background font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-current={tab === t ? "page" : undefined}
          >
            {tabLabels[t]}
          </Link>
        ))}
      </nav>

      {/* Tab content */}
      {tab === "overview" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <InfoCard title={dict.patients.profile.overview.personalInfo}>
            <InfoRow label={dict.patients.fields.fullName} value={patient.fullName} />
            <InfoRow
              label={dict.patients.fields.gender}
              value={dict.statuses.gender[patient.gender]}
            />
            <InfoRow
              label={dict.patients.fields.dateOfBirth}
              value={patient.dateOfBirth ?? dict.common.noValue}
              ltr={Boolean(patient.dateOfBirth)}
            />
            <InfoRow label={dict.patients.fields.mobile} value={patient.mobile} ltr />
            <InfoRow
              label={dict.patients.fields.alternateMobile}
              value={patient.alternateMobile ?? dict.common.noValue}
              ltr={Boolean(patient.alternateMobile)}
            />
            <InfoRow
              label={dict.patients.fields.address}
              value={patient.address ?? dict.common.noValue}
            />
          </InfoCard>

          <div className="flex flex-col gap-4">
            <InfoCard title={dict.patients.profile.overview.clinicalInfo}>
              <InfoRow
                label={dict.patients.fields.treatingDoctor}
                value={doctorName ?? dict.patients.fields.noDoctor}
              />
              <InfoRow
                label={dict.patients.fields.treatmentType}
                value={patient.treatmentType ?? dict.common.noValue}
              />
              <InfoRow
                label={dict.patients.fields.treatmentStatus}
                badge={
                  <TreatmentStatusBadge
                    status={patient.treatmentStatus}
                    dict={dict}
                  />
                }
              />
            </InfoCard>
            <InfoCard title={dict.patients.profile.overview.recallInfo}>
              <InfoRow
                label={dict.patients.fields.recallIntervalDays}
                value={String(patient.recallIntervalDays)}
              />
              <InfoRow
                label={dict.followUp.columns.recallDue}
                value={
                  assessment.recallDueIsoDate ?? dict.patients.profile.summary.never
                }
                ltr={Boolean(assessment.recallDueIsoDate)}
              />
            </InfoCard>
          </div>
        </div>
      ) : null}

      {tab === "appointments" ? (
        appointmentRows.length === 0 ? (
          <EmptyState
            icon={CalendarPlusIcon}
            title={dict.appointments.emptyTitle}
            description={dict.appointments.emptyHint}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {appointmentRows.map((row) => (
              <li key={row.id} className="border-muted rounded-lg border p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" dir="ltr">
                        {formatZonedDateTime(new Date(row.appointmentDate), locale)}
                      </span>
                      <AppointmentStatusBadge status={row.status} dict={dict} />
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {row.doctorName}
                      {row.reason ? ` · ${row.reason}` : ""}
                    </p>
                  </div>
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
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === "visits" ? (
        visitRows.length === 0 ? (
          <EmptyState
            icon={StethoscopeIcon}
            title={dict.visits.empty}
            description={dict.patients.profile.newVisit}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {visitRows.map((row) => (
              <li key={row.id} className="border-muted rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/visits/${row.id}`}
                        className="hover:text-primary font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {formatZonedDate(new Date(row.visitDate), locale)}
                      </Link>
                      <VisitStatusBadge status={row.status} dict={dict} />
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                      {row.doctorName}
                      {row.treatmentPerformed ? ` · ${row.treatmentPerformed}` : ""}
                    </p>
                  </div>
                  <Link
                    href={`/visits/${row.id}`}
                    className="text-primary hover:underline text-sm rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {dict.visits.list.open}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === "contacts" ? (
        contactRows.length === 0 ? (
          <EmptyState
            icon={PhoneIcon}
            title={dict.followUp.contactHistory.empty}
            description={dict.followUp.actions.markContacted}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {contactRows.map((row) => (
              <li
                key={row.id}
                className="border-muted flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">
                      {dict.statuses.contactType[row.contactType]}
                    </span>
                    <ContactResultBadge result={row.result} dict={dict} />
                  </div>
                  {row.note ? (
                    <p className="text-muted-foreground mt-0.5 text-sm">{row.note}</p>
                  ) : null}
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatZonedDateTime(new Date(row.contactedAt), locale)} ·{" "}
                  {row.byName}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === "treatment" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <InfoCard title={dict.patients.profile.overview.clinicalInfo}>
            <InfoRow
              label={dict.patients.fields.treatmentType}
              value={patient.treatmentType ?? dict.common.noValue}
            />
            <InfoRow
              label={dict.patients.fields.treatmentStatus}
              badge={
                <TreatmentStatusBadge
                  status={patient.treatmentStatus}
                  dict={dict}
                />
              }
            />
            <InfoRow
              label={dict.patients.fields.recallIntervalDays}
              value={String(patient.recallIntervalDays)}
            />
          </InfoCard>
          <InfoCard title={dict.patients.fields.notes}>
            <p className="text-sm whitespace-pre-wrap">
              {patient.notes ?? dict.common.noValue}
            </p>
          </InfoCard>
        </div>
      ) : null}

      {tab === "payments" ? (
        <PatientFinanceSection
          patientId={patient.id}
          patientName={patient.fullName}
          role={user.role}
        />
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-muted rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
}

function InfoCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-muted rounded-lg border">
      <h2 className="border-muted border-b px-3 py-2 text-sm font-medium">
        {title}
      </h2>
      <dl className="flex flex-col">{children}</dl>
    </section>
  );
}

function InfoRow({
  label,
  value,
  badge,
  ltr,
}: {
  label: string;
  value?: string;
  badge?: React.ReactNode;
  ltr?: boolean;
}) {
  return (
    <div className="border-muted/60 flex items-start justify-between gap-3 border-b px-3 py-2 last:border-b-0">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-end text-sm font-medium" dir={ltr ? "ltr" : undefined}>
        {badge ?? value}
      </dd>
    </div>
  );
}
