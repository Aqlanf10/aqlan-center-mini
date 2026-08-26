import { CalendarDaysIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";

export default async function AppointmentsPage() {
  await requireUser("/appointments");
  const { dict } = await getI18n();

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.appointments.title}
        subtitle={dict.appointments.subtitle}
      />
      <EmptyState
        icon={CalendarDaysIcon}
        title={dict.appointments.emptyTitle}
        description={dict.appointments.emptyHint}
      />
    </div>
  );
}
