import { and, eq, like } from "drizzle-orm";
import { FileTextIcon } from "lucide-react";

import { db } from "@/lib/db";
import { patients } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDateTime } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { UrlFilterSelect } from "@/components/shared/url-filter-select";
import { UrlPagination } from "@/components/shared/url-pagination";
import { UrlSearchInput } from "@/components/shared/url-search-input";
import { Badge } from "@/components/ui/badge";
import {
  ReceiptVoucherDialog,
  VoucherReversalDialog,
  VoucherPrintButton,
} from "@/components/finance/voucher-dialogs";
import { getCashAccountBalances, listVouchers } from "@/server/finance/reports";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireRole(["ADMIN", "RECEPTION"], "/finance/receipts");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const q = single(params.q)?.trim() ?? "";
  const currency = single(params.currency) ?? "";
  const page = Math.max(1, Number.parseInt(single(params.page) ?? "1", 10) || 1);

  // RECEPTION sees all receipts (create + print are its job) but can only
  // issue patient receipts — enforced in the action, not just the UI.
  const isAdmin = user.role === "ADMIN";

  const balances = await getCashAccountBalances();
  const activeAccounts = balances
    .filter((account) => account.active)
    .map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
    }));

  // Patient options for the create dialog (search by name via LIKE).
  const patientRows = q
    ? await db
        .select({ id: patients.id, fileNumber: patients.fileNumber, fullName: patients.fullName })
        .from(patients)
        .where(
          and(
            eq(patients.active, true),
            like(patients.fullName, `%${q}%`),
          )
        )
        .limit(20)
    : [];

  const { rows, total } = await listVouchers({
    type: "RECEIPT",
    currency: currency === "YER" || currency === "SAR" || currency === "USD" ? currency : undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const filtered = q
    ? rows.filter(
        (row) =>
          row.voucherNumber.toLowerCase().includes(q.toLowerCase()) ||
          (row.patientName ?? "").includes(q)
      )
    : rows;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.financeVouchers.receiptsTitle}
        subtitle={dict.financeVouchers.receiptsSubtitle}
        actions={
          <ReceiptVoucherDialog
            cashAccounts={activeAccounts}
            patients={patientRows.map((patient) => ({
              id: patient.id,
              label: `${patient.fullName} (${patient.fileNumber})`,
            }))}
          />
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <UrlSearchInput placeholder={dict.common.searchPlaceholder} />
        <UrlFilterSelect
          paramName="currency"
          label={dict.financeVouchers.fields.currency}
          anyLabel={dict.common.all}
          options={[
            { value: "YER", label: "YER" },
            { value: "SAR", label: "SAR" },
            { value: "USD", label: "USD" },
          ]}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={FileTextIcon}
          title={dict.financeVouchers.empty}
          description={dict.financeVouchers.emptyHint}
        />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-muted-foreground bg-muted/50 border-b text-start">
              <tr>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.number}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.date}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.party}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.amount}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.method}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.status}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.common.actions}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="px-3 py-2.5 font-mono text-xs" dir="ltr">
                    {row.voucherNumber}
                    {row.reversalOfVoucherId ? (
                      <span className="text-muted-foreground ms-1">↩</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {formatZonedDateTime(row.voucherDate, locale)}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.patientName ?? row.otherPartyName ?? dict.common.unknown}
                  </td>
                  <td className="px-3 py-2.5 font-semibold whitespace-nowrap" dir="ltr">
                    {formatMoney(
                      Math.round(parseFloat(row.amount) * 100),
                      row.currency,
                      locale
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {dict.financeVouchers.paymentMethods[
                      row.paymentMethod as "CASH"
                    ]}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.status === "REVERSED" ? (
                      <Badge variant="destructive">{dict.financeVouchers.reversed}</Badge>
                    ) : row.reversalOfVoucherId ? (
                      <Badge variant="outline">{dict.financeVouchers.isReversal}</Badge>
                    ) : (
                      <Badge variant="secondary">{dict.financeVouchers.active}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <VoucherPrintButton voucherId={row.id} />
                      {isAdmin && row.status === "ACTIVE" && !row.reversalOfVoucherId ? (
                        <VoucherReversalDialog
                          voucherId={row.id}
                          voucherNumber={row.voucherNumber}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {dict.common.resultsCount.replace("{count}", String(total))}
        </p>
        <UrlPagination page={page} pageCount={totalPages} />
      </div>
    </div>
  );
}
