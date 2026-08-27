import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { ArrowRightIcon } from "lucide-react";

import { db } from "@/lib/db";
import { visitCorrections, users as usersTable } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { PageHeader } from "@/components/shared/page-header";
import { VisitStatusBadge } from "@/components/shared/status-badges";
import { VisitForm } from "@/components/visits/visit-form";
import { VisitWorkItems } from "@/components/visits/visit-work-items";
import { VisitCorrectionDialog } from "@/components/visits/visit-correction-dialog";
import { formatDateTimeLocalInput, formatZonedDateTime } from "@/lib/datetime";
import { getVisitById } from "@/server/visits/queries";
import { listDoctors } from "@/server/appointments/queries";
import { listVisitWorkItems } from "@/server/services/work-items";
import { listServices } from "@/server/services/catalog";

export const dynamic = "force-dynamic";

export default async function VisitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser("/today");
  const { locale, dict } = await getI18n();

  if (user.role === "RECEPTION") {
    // Reception does not record clinical visits (server-side enforced).
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={dict.visits.title} subtitle={dict.errors.forbidden} />
      </div>
    );
  }

  const { id } = await params;
  const [visit, doctors] = await Promise.all([getVisitById(id), listDoctors()]);
  if (!visit) {
    notFound();
  }

  const locked = visit.status === "COMPLETED";

  const workItems = await listVisitWorkItems(id);
  const services = await listServices();
  const corrections = locked
    ? await db
        .select({
          id: visitCorrections.id,
          note: visitCorrections.note,
          reason: visitCorrections.reason,
          createdAt: visitCorrections.createdAt,
          createdByName: usersTable.name,
        })
        .from(visitCorrections)
        .leftJoin(usersTable, eq(visitCorrections.createdBy, usersTable.id))
        .where(eq(visitCorrections.visitId, id))
        .orderBy(desc(visitCorrections.createdAt))
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={`/patients/${visit.patientId}`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowRightIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
          {visit.patientName}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{dict.visits.newVisit}</h1>
          <VisitStatusBadge status={visit.status} dict={dict} />
        </div>
        <p className="text-muted-foreground text-sm">
          <span className="font-mono" dir="ltr">
            {visit.fileNumber}
          </span>
          {" · "}
          {visit.doctorName}
        </p>
      </div>

      <VisitForm
        visitId={visit.id}
        doctors={doctors}
        patientName={visit.patientName}
        patientId={visit.patientId}
        isDraft={visit.status === "DRAFT"}
        initialValues={{
          doctorId: visit.doctorId,
          visitDate: formatDateTimeLocalInput(new Date(visit.visitDate)),
          chiefComplaint: visit.chiefComplaint ?? "",
          treatmentPerformed: visit.treatmentPerformed ?? "",
          clinicalNotes: visit.clinicalNotes ?? "",
          nextVisitPlan: visit.nextVisitPlan ?? "",
        }}
      />

      <VisitWorkItems
        visitId={visit.id}
        locked={locked}
        canEdit={user.role === "ADMIN" || user.role === "DOCTOR"}
        items={workItems.map((item) => ({
          id: item.id,
          serviceId: item.serviceId,
          serviceLabel: `${item.serviceCode} — ${locale === "ar" ? item.serviceNameAr : item.serviceNameEn}`,
          doctorId: item.doctorId,
          doctorName: item.doctorName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          total: item.total,
          currency: item.currency,
          notes: item.notes,
          status: item.status,
        }))}
        source={{
          services: services.map((service) => ({
            id: service.id,
            label: `${service.code} — ${locale === "ar" ? service.nameAr : service.nameEn}`,
            defaultPrice: service.defaultPrice,
            currency: service.currency,
          })),
          doctors: doctors.map((doctor) => ({
            id: doctor.id,
            label: doctor.name,
          })),
        }}
      />

      {locked ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">{dict.visitCorrections.title}</h2>
              <p className="text-muted-foreground text-sm">
                {dict.visitCorrections.lockedNotice}
              </p>
            </div>
            {user.role === "ADMIN" ? (
              <VisitCorrectionDialog visitId={visit.id} />
            ) : null}
          </div>
          {corrections.length === 0 ? (
            <p className="text-muted-foreground text-sm">{dict.visitCorrections.empty}</p>
          ) : (
            <ul className="space-y-2">
              {corrections.map((correction) => (
                <li key={correction.id} className="bg-card rounded-xl border p-3">
                  <p className="text-sm">{correction.note}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {dict.visitCorrections.reason}: {correction.reason} ·{" "}
                    {dict.visitCorrections.by}: {correction.createdByName ?? dict.common.unknown} ·{" "}
                    {formatZonedDateTime(correction.createdAt, locale)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <span className="sr-only">{locale}</span>
    </div>
  );
}
