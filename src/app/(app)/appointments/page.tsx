import Link from "next/link";
import { CalendarDaysIcon } from "lucide-react";

import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDateTime, getTodayIsoDate } from "@/lib/datetime";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { UrlFilterSelect } from "@/components/shared/url-filter-select";
import { UrlPagination } from "@/components/shared/url-pagination";
import { AppointmentStatusBadge } from "@/components/shared/status-badges";
import { AppointmentFormDialog } from "@/components/appointments/appointment-form-dialog";
import { AppointmentQuickActions } from "@/components/appointments/quick-actions";
import { listAppointments, listDoctors } from "@/server/appointments/queries";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireUser("/appointments");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const date = single(params.date);
  const status = single(params.status);
  const doctorId = single(params.doctor);
  const page = Math.max(1, Number.parseInt(single(params.page) ?? "1", 10) || 1);

  const [doctors, result] = await Promise.all([
    listDoctors(),
    listAppointments({ date, status, doctorId, page }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={dict.appointments.title}
        subtitle={dict.appointments.subtitle}
        actions={<AppointmentFormDialog doctors={doctors} trigger={dict.appointments.new} />}
      />

      <div className="flex flex-wrap items-end gap-3">
        <UrlFilterSelect
          paramName="date"
          label={dict.appointments.filters.date}
          anyLabel={dict.appointments.filters.anyDate}
          options={[
            { value: getTodayIsoDate(), label: dict.common.today },
          ]}
        />
        <UrlFilterSelect
          paramName="status"
          label={dict.appointments.list.status}
          anyLabel={dict.appointments.filters.allStatuses}
          options={(["SCHEDULED", "CONFIRMED", "ARRIVED", "IN_TREATMENT", "COMPLETED", "CANCELLED", "NO_SHOW"] as const).map(
            (value) => ({ value, label: dict.statuses.appointment[value] })
          )}
        />
        <UrlFilterSelect
          paramName="doctor"
          label={dict.appointments.list.doctor}
          anyLabel={dict.appointments.filters.anyDoctor}
          options={doctors.map((doctor) => ({ value: doctor.id, label: doctor.name }))}
        />
      </div>

      {result.rows.length === 0 ? (
        <EmptyState
          icon={CalendarDaysIcon}
          title={dict.appointments.emptyTitle}
          description={dict.appointments.emptyHint}
        />
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            {dict.common.resultsCount.replace("{count}", String(result.total))}
          </p>

          {/* Desktop table */}
          <div className="border-muted hidden overflow-x-auto rounded-lg border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.appointments.list.date}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.appointments.list.patient}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.appointments.list.doctor}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.appointments.list.reason}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.appointments.list.status}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.appointments.list.actions}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/40 border-muted border-t">
                    <td className="px-3 py-2.5 whitespace-nowrap" dir="ltr">
                      {formatZonedDateTime(new Date(row.appointmentDate), locale)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/patients/${row.patientId}`}
                        className="hover:text-primary font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {row.patientName}
                      </Link>
                      <span className="text-muted-foreground block font-mono text-xs" dir="ltr">
                        {row.fileNumber}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{row.doctorName}</td>
                    <td className="max-w-48 truncate px-3 py-2.5">{row.reason ?? dict.common.noValue}</td>
                    <td className="px-3 py-2.5">
                      <AppointmentStatusBadge status={row.status} dict={dict} />
                    </td>
                    <td className="px-3 py-2.5">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {result.rows.map((row) => (
              <li key={row.id} className="border-muted rounded-lg border p-3">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/patients/${row.patientId}`}
                      className="font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {row.patientName}
                    </Link>
                    <AppointmentStatusBadge status={row.status} dict={dict} />
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {formatZonedDateTime(new Date(row.appointmentDate), locale)} · {row.doctorName}
                  </p>
                  <p className="text-muted-foreground font-mono text-xs" dir="ltr">
                    {row.fileNumber}
                  </p>
                  {row.reason ? <p className="text-sm">{row.reason}</p> : null}
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

          <UrlPagination page={result.page} pageCount={result.pageCount} />
        </>
      )}

    </div>
  );
}
