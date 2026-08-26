import { asc } from "drizzle-orm";
import { UsersRoundIcon } from "lucide-react";

import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ActiveBadge, RoleBadge } from "@/components/shared/status-badges";
import { StaffCreateDialog } from "@/components/staff/staff-create-dialog";
import { StaffRowActions } from "@/components/staff/staff-row-actions";

export const dynamic = "force-dynamic";

/** ADMIN-only staff management: view, add, activate/deactivate, assign role. */
export default async function StaffPage() {
  const current = await requireRole(["ADMIN"], "/settings/staff");
  const { locale, dict } = await getI18n();

  const staff = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      email: users.email,
      role: users.role,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.name));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={dict.staff.title}
        subtitle={dict.staff.subtitle}
        actions={<StaffCreateDialog trigger={dict.staff.add} />}
      />

      {staff.length === 0 ? (
        <EmptyState
          icon={UsersRoundIcon}
          title={dict.staff.empty}
          description={dict.staff.subtitle}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {staff.map((member) => (
            <li
              key={member.id}
              className="border-muted rounded-lg border p-3 sm:p-4"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {member.name}
                      {member.id === current.id ? (
                        <span className="text-muted-foreground text-xs">
                          {" "}
                          ({dict.auth.signedInAs.toLowerCase()})
                        </span>
                      ) : null}
                    </span>
                    <RoleBadge role={member.role} dict={dict} />
                    <ActiveBadge active={member.active} dict={dict} />
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-sm" dir="ltr">
                    @{member.username} · {member.email}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {dict.staff.fields.createdAt}:{" "}
                    {formatZonedDate(new Date(member.createdAt), locale)}
                  </p>
                </div>

                {member.id === current.id ? (
                  <p className="text-muted-foreground text-xs">
                    {dict.staff.errors.cannotDeactivateSelf}
                  </p>
                ) : (
                  <StaffRowActions
                    userId={member.id}
                    name={member.name}
                    active={member.active}
                    role={member.role}
                    isSelf={member.id === current.id}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
