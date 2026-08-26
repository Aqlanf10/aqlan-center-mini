import { ActivityIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";

export default async function TodayPage() {
  await requireUser("/today");
  const { dict } = await getI18n();

  return (
    <div className="space-y-6">
      <PageHeader title={dict.today.title} subtitle={dict.today.subtitle} />
      <EmptyState
        icon={ActivityIcon}
        title={dict.today.emptyTitle}
        description={dict.today.emptyHint}
      />
    </div>
  );
}
