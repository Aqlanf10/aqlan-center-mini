import Link from "next/link";
import { eq, sql, and, gte, lt } from "drizzle-orm";
import { BanknoteIcon, BarChart3Icon } from "lucide-react";

import { db } from "@/lib/db";
import { users, vouchers } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { getAppDayRangeUtc } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ReceiptVoucherDialog, PaymentVoucherDialog } from "@/components/finance/voucher-dialogs";
import { getCashAccountBalances } from "@/server/finance/reports";
import { listExpenseCategories } from "@/server/finance/accounts";
import { listLabs } from "@/server/labs/labs";
import { listSuppliers } from "@/server/suppliers/suppliers";

export const dynamic = "force-dynamic";

export default async function FinanceOverviewPage() {
  await requireRole(["ADMIN"], "/finance");
  const { locale, dict } = await getI18n();

  const balances = await getCashAccountBalances();

  const { startUtc, endUtc } = getAppDayRangeUtc(new Date());
  const todayTotals = await db
    .select({
      type: vouchers.type,
      currency: vouchers.currency,
      total: sql<string>`sum(CASE WHEN ${vouchers.reversalOfVoucherId} IS NULL THEN ${vouchers.amount} ELSE -${vouchers.amount} END)`,
    })
    .from(vouchers)
    .where(
      and(gte(vouchers.voucherDate, startUtc), lt(vouchers.voucherDate, endUtc))
    )
    .groupBy(vouchers.type, vouchers.currency);

  const doctors = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.role, "DOCTOR"), eq(users.active, true)))
    .limit(50);
  const labs = await listLabs();
  const suppliers = await listSuppliers();
  const expenseCategories = await listExpenseCategories();
  const activeAccounts = balances.filter((account) => account.active);

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.financeHub.title}
        subtitle={dict.financeHub.subtitle}
        actions={
          <div className="flex flex-wrap gap-2">
            <ReceiptVoucherDialog
              cashAccounts={activeAccounts.map((a) => ({
                id: a.id,
                name: a.name,
                currency: a.currency,
              }))}
              patients={[]}
            />
            <PaymentVoucherDialog
              cashAccounts={activeAccounts.map((a) => ({
                id: a.id,
                name: a.name,
                currency: a.currency,
              }))}
              doctors={doctors.map((d) => ({ id: d.id, label: d.name }))}
              labs={labs.map((l) => ({ id: l.id, label: l.name }))}
              suppliers={suppliers.map((s) => ({ id: s.id, label: s.name }))}
              expenseCategories={expenseCategories}
            />
          </div>
        }
      />

      {/* Treasury balances — one card per account, never mixed */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{dict.financeHub.cashAccounts}</h2>
        {activeAccounts.length === 0 ? (
          <EmptyState
            icon={BanknoteIcon}
            title={dict.financeHub.noAccounts}
            description={dict.financeAccounts.cashAccountsSubtitle}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {activeAccounts.map((account) => (
              <div key={account.id} className="bg-card rounded-xl border p-4">
                <p className="text-muted-foreground text-xs">
                  {dict.financeAccounts.types[account.type]}
                </p>
                <p className="mt-1 truncate text-sm font-semibold">{account.name}</p>
                <p className="mt-2 text-xl font-bold" dir="ltr">
                  {formatMoney(account.balanceMinor, account.currency, locale)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Today's movements */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{dict.financeHub.treasuryMovements}</h2>
        {todayTotals.length === 0 ? (
          <EmptyState
            icon={BanknoteIcon}
            title={dict.financeHub.emptyBalances}
            description={dict.financeReports.currencyWarning}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(["RECEIPT", "PAYMENT"] as const).map((type) => {
              const rows = todayTotals.filter((row) => row.type === type);
              return (
                <div key={type} className="bg-card rounded-xl border p-4">
                  <p className="text-muted-foreground text-xs">
                    {type === "RECEIPT"
                      ? dict.financeHub.receiptsToday
                      : dict.financeHub.paymentsToday}
                  </p>
                  {rows.length === 0 ? (
                    <p className="text-muted-foreground mt-2 text-sm">
                      {dict.financeReports.noData}
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1" dir="ltr">
                      {rows.map((row) => (
                        <li key={row.currency} className="flex justify-between text-sm">
                          <span className="font-medium">{row.currency}</span>
                          <span className="font-semibold">
                            {formatMoney(
                              Math.round(parseFloat(row.total ?? "0") * 100),
                              row.currency,
                              locale
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Quick links */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link
          href="/finance/reports?view=daily-closing"
          className="bg-card hover:bg-accent rounded-xl border p-4 transition-colors"
        >
          <BarChart3Icon className="mb-2 size-5" aria-hidden="true" />
          <p className="text-sm font-semibold">{dict.financeHub.dailyClosing}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {dict.financeReports.dailyClosingSubtitle}
          </p>
        </Link>
        <Link
          href="/finance/reports?view=period"
          className="bg-card hover:bg-accent rounded-xl border p-4 transition-colors"
        >
          <BarChart3Icon className="mb-2 size-5" aria-hidden="true" />
          <p className="text-sm font-semibold">{dict.financeHub.periodReport}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {dict.financeReports.periodReportSubtitle}
          </p>
        </Link>
        <Link
          href="/finance/commissions"
          className="bg-card hover:bg-accent rounded-xl border p-4 transition-colors"
        >
          <BanknoteIcon className="mb-2 size-5" aria-hidden="true" />
          <p className="text-sm font-semibold">{dict.financeHub.commissions}</p>
          <p className="text-muted-foreground mt-1 text-xs">{dict.commissions.subtitle}</p>
        </Link>
        <Link
          href="/finance/cash-accounts"
          className="bg-card hover:bg-accent rounded-xl border p-4 transition-colors"
        >
          <BanknoteIcon className="mb-2 size-5" aria-hidden="true" />
          <p className="text-sm font-semibold">
            {dict.financeAccounts.cashAccountsTitle}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {dict.financeAccounts.cashAccountsSubtitle}
          </p>
        </Link>
      </section>

      <p className="text-muted-foreground text-xs">{dict.financeHub.accessNote}</p>
    </div>
  );
}
