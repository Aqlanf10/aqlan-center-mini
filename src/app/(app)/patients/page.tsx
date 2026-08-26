import { UsersIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";

export default async function PatientsPage() {
  await requireUser("/patients");
  const { dict } = await getI18n();

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.patients.title}
        subtitle={dict.patients.subtitle}
      />
      <EmptyState
        icon={UsersIcon}
        title={dict.patients.emptyTitle}
        description={dict.patients.emptyHint}
      />
    </div>
  );
}
