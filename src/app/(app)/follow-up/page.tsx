import { PhoneCallIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";

const QUEUE_KEYS = [
  "dueToday",
  "dueSoon",
  "overdue",
  "noNextAppointment",
  "missedAppointments",
] as const;

export default async function FollowUpPage() {
  await requireUser("/follow-up");
  const { dict } = await getI18n();

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.followUp.title}
        subtitle={dict.followUp.subtitle}
      />
      <EmptyState
        icon={PhoneCallIcon}
        title={dict.followUp.emptyTitle}
        description={dict.followUp.emptyHint}
      >
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {QUEUE_KEYS.map((key) => (
            <Badge key={key} variant="outline" className="bg-background">
              {dict.followUp.queues[key]}
            </Badge>
          ))}
        </div>
      </EmptyState>
    </div>
  );
}
