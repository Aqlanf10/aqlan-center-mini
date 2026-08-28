import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/guards";
import { getDraftVisitByAppointment } from "@/server/visits/queries";

export const dynamic = "force-dynamic";

/**
 * Convenience route: open the DRAFT visit attached to an appointment
 * (Today -> "Open visit" while IN_TREATMENT).
 */
export default async function VisitByAppointmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser("/today");

  const { id } = await params;
  const draft = await getDraftVisitByAppointment(id);
  if (!draft) {
    notFound();
  }
  redirect(`/visits/${draft.id}`);
}
