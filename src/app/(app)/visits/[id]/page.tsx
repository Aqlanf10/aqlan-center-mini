import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRightIcon } from "lucide-react";

import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { PageHeader } from "@/components/shared/page-header";
import { VisitStatusBadge } from "@/components/shared/status-badges";
import { VisitForm } from "@/components/visits/visit-form";
import { formatDateTimeLocalInput } from "@/lib/datetime";
import { getVisitById } from "@/server/visits/queries";
import { listDoctors } from "@/server/appointments/queries";

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

      <span className="sr-only">{locale}</span>
    </div>
  );
}
