import { and, eq } from "drizzle-orm";
import { BanknoteIcon } from "lucide-react";

import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { UrlFilterSelect } from "@/components/shared/url-filter-select";
import {
  CommissionApproveButton,
  CommissionPayButton,
  CommissionReverseButton,
  CommissionSetAmountButton,
} from "@/components/commissions/commission-actions";
import {
  CommissionPlanDeleteButton,
  CommissionPlanDialog,
} from "@/components/commissions/plan-dialogs";
import { getCashAccountBalances } from "@/server/finance/reports";
import { listCommissions, listPlans } from "@/server/commissions/engine";
import { listServices } from "@/server/services/catalog";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_BADGE: Record<string, "secondary" | "default" | "outline" | "destructive"> = {
  PENDING: "secondary",
  APPROVED: "default",
  PAID: "outline",
  REVERSED: "destructive",
};

export default async function CommissionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/finance/commissions");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const status = single(params.status);
  const validStatus =
    status === "PENDING" || status === "APPROVED" || status === "PAID" || status === "REVERSED"
      ? status
      : undefined;

  const doctors = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.role, "DOCTOR"), eq(users.active, true)))
    .limit(50);
  const services = await listServices();
  const plans = await listPlans();
  const commissions = await listCommissions({ status: validStatus, limit: 100 });
  const balances = await getCashAccountBalances();
  const activeAccounts = balances
    .filter((account) => account.active)
    .map((account) => ({ id: account.id, name: account.name, currency: account.currency }));

  return (
    <div className="space-y-6">
      <PageHeader title={dict.commissions.title} subtitle={dict.commissions.subtitle} />

      {/* Plans */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.commissions.plansTitle}</h2>
          <CommissionPlanDialog
            doctors={doctors.map((d) => ({ id: d.id, label: d.name }))}
            services={services.map((s) => ({
              id: s.id,
              label: `${s.code} — ${locale === "ar" ? s.nameAr : s.nameEn}`,
            }))}
          />
        </div>
        {plans.length === 0 ? (
          <EmptyState
            icon={BanknoteIcon}
            title={dict.commissions.emptyPlans}
            description={dict.commissions.subtitle}
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.fields.doctor}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.fields.service}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.fields.basis}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.fields.type}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.fields.value}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-medium">{plan.doctorName}</td>
                    <td className="px-3 py-2.5">
                      {plan.serviceId
                        ? `${plan.serviceCode ?? ""} — ${locale === "ar" ? plan.serviceNameAr : plan.serviceNameEn}`
                        : dict.commissions.basis.WORK_VALUE === "العمل المنجز"
                          ? "الخطة الافتراضية"
                          : "Doctor default"}
                    </td>
                    <td className="px-3 py-2.5">{dict.commissions.basis[plan.basis]}</td>
                    <td className="px-3 py-2.5">{dict.commissions.types[plan.type]}</td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {plan.type === "PERCENT" ? `${plan.value}%` : plan.value}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        <CommissionPlanDialog
                          doctors={doctors.map((d) => ({ id: d.id, label: d.name }))}
                          services={services.map((s) => ({
                            id: s.id,
                            label: `${s.code} — ${locale === "ar" ? s.nameAr : s.nameEn}`,
                          }))}
                          plan={{
                            id: plan.id,
                            doctorId: plan.doctorId,
                            serviceId: plan.serviceId,
                            basis: plan.basis,
                            type: plan.type,
                            value: plan.value,
                          }}
                        />
                        <CommissionPlanDeleteButton planId={plan.id} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Commissions */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.commissions.title}</h2>
          <UrlFilterSelect
            paramName="status"
            label={dict.common.status}
            anyLabel={dict.common.all}
            options={[
              { value: "PENDING", label: dict.commissions.statuses.PENDING },
              { value: "APPROVED", label: dict.commissions.statuses.APPROVED },
              { value: "PAID", label: dict.commissions.statuses.PAID },
              { value: "REVERSED", label: dict.commissions.statuses.REVERSED },
            ]}
          />
        </div>
        {commissions.length === 0 ? (
          <EmptyState icon={BanknoteIcon} title={dict.commissions.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.doctor}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.basis}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.plan}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.base}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.amount}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.status}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.date}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {commissions.map((commission) => (
                  <tr key={commission.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-medium">{commission.doctorName}</td>
                    <td className="px-3 py-2.5">{dict.commissions.basis[commission.basis]}</td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {commission.planType
                        ? `${dict.commissions.types[commission.planType]} ${commission.planValue ?? ""}`
                        : dict.commissions.needsPlan}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {formatMoney(
                        Math.round(parseFloat(commission.baseAmount) * 100),
                        commission.currency,
                        locale
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-semibold" dir="ltr">
                      {commission.amount
                        ? formatMoney(
                            Math.round(parseFloat(commission.amount) * 100),
                            commission.currency,
                            locale
                          )
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_BADGE[commission.status] ?? "secondary"}>
                        {dict.commissions.statuses[commission.status]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {formatZonedDate(commission.createdAt, locale)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {commission.status === "PENDING" && !commission.amount ? (
                          <CommissionSetAmountButton commissionId={commission.id} />
                        ) : null}
                        {commission.status === "PENDING" && commission.amount ? (
                          <CommissionApproveButton commissionId={commission.id} />
                        ) : null}
                        {commission.status === "APPROVED" ? (
                          <CommissionPayButton
                            commissionId={commission.id}
                            cashAccounts={activeAccounts.filter(
                              (account) => account.currency === commission.currency
                            )}
                          />
                        ) : null}
                        {commission.status === "PENDING" || commission.status === "APPROVED" ? (
                          <CommissionReverseButton commissionId={commission.id} />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
