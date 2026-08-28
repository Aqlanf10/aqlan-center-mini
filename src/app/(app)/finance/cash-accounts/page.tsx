import { BanknoteIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  CashAccountActiveButton,
  CashAccountDialog,
} from "@/components/finance/account-dialogs";
import { getCashAccountBalances } from "@/server/finance/reports";

export const dynamic = "force-dynamic";

export default async function CashAccountsPage() {
  await requireRole(["ADMIN"], "/finance/cash-accounts");
  const { locale, dict } = await getI18n();

  const accounts = await getCashAccountBalances();

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.financeAccounts.cashAccountsTitle}
        subtitle={dict.financeAccounts.cashAccountsSubtitle}
        actions={<CashAccountDialog buttonLabel={dict.financeAccounts.newAccount} />}
      />

      {accounts.length === 0 ? (
        <EmptyState
          icon={BanknoteIcon}
          title={dict.financeAccounts.empty}
          description={dict.financeAccounts.cashAccountsSubtitle}
        />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-muted-foreground bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeAccounts.fields.name}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeAccounts.fields.currency}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeAccounts.fields.type}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeAccounts.balance}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.common.status}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.common.actions}
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-b last:border-0">
                  <td className="px-3 py-2.5 font-medium">{account.name}</td>
                  <td className="px-3 py-2.5" dir="ltr">
                    {account.currency}
                  </td>
                  <td className="px-3 py-2.5">
                    {dict.financeAccounts.types[account.type]}
                  </td>
                  <td className="px-3 py-2.5 font-semibold" dir="ltr">
                    {formatMoney(account.balanceMinor, account.currency, locale)}
                  </td>
                  <td className="px-3 py-2.5">
                    {account.active ? (
                      <Badge variant="secondary">{dict.common.active}</Badge>
                    ) : (
                      <Badge variant="outline">{dict.common.inactive}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CashAccountDialog
                        account={{
                          id: account.id,
                          name: account.name,
                          type: account.type,
                        }}
                        buttonLabel={dict.common.edit}
                      />
                      <CashAccountActiveButton
                        accountId={account.id}
                        active={account.active}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {dict.financeReports.currencyWarning}
      </p>
    </div>
  );
}
