import Link from "next/link";
import { PrinterIcon } from "lucide-react";

import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { ChargeFormDialog } from "@/components/finance/finance-dialogs";
import { ReceiptVoucherDialog } from "@/components/finance/voucher-dialogs";
import { Button } from "@/components/ui/button";
import { listCashAccounts } from "@/server/finance/accounts";
import { getPatientFinance } from "@/server/finance/queries";
import type { Currency } from "@/db/schema/enums";
import type { UserRole } from "@/db/schema/enums";

/**
 * Patient billing tab (server component). Currencies are displayed
 * separately — never merged into one total.
 *
 * Role matrix (also enforced server-side in every action):
 *   - charges: ADMIN + DOCTOR
 *   - patient receipts (vouchers): ADMIN + RECEPTION
 *   - doctors never create financial vouchers.
 */
export async function PatientFinanceSection({
  patientId,
  patientName,
  role,
}: {
  patientId: string;
  patientName: string;
  role: UserRole;
}) {
  const { locale, dict } = await getI18n();
  const [finance, cashAccounts] = await Promise.all([
    getPatientFinance(patientId),
    // Only needed for the receipt dialog (ADMIN/RECEPTION).
    role === "RECEPTION" || role === "ADMIN"
      ? listCashAccounts()
      : Promise.resolve([]),
  ]);

  const currencies: Currency[] = ["YER", "SAR", "USD"];

  return (
    <div className="flex flex-col gap-4">
      {/* Per-currency balances */}
      <section className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {currencies.map((currency) => {
          const minor = finance.balances[currency];
          const hasAny = minor !== 0 || entryExists(finance, currency);
          return (
            <div key={currency} className="border-muted rounded-lg border p-3">
              <p className="text-muted-foreground text-xs">
                {dict.finance.balance} · {currency}
              </p>
              <p
                className={`mt-1 text-lg font-semibold tabular-nums ${
                  minor > 0
                    ? "text-red-600 dark:text-red-400"
                    : minor < 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ""
                }`}
                dir="ltr"
              >
                {hasAny ? formatMoney(minor, currency, locale) : dict.finance.noCurrencyBalance}
              </p>
              {hasAny ? (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {minor > 0
                    ? dict.finance.outstanding
                    : minor < 0
                      ? dict.finance.credit
                      : dict.finance.settled}
                </p>
              ) : null}
            </div>
          );
        })}
      </section>

      <div className="flex flex-wrap gap-2">
        {(role === "ADMIN" || role === "DOCTOR") && (
          <ChargeFormDialog patientId={patientId} />
        )}
        {(role === "ADMIN" || role === "RECEPTION") && (
          <ReceiptVoucherDialog
            cashAccounts={cashAccounts
              .filter((account) => account.active)
              .map((account) => ({
                id: account.id,
                name: account.name,
                currency: account.currency,
              }))}
            patients={[]}
            fixedPatientId={patientId}
            fixedPatientLabel={patientName}
          />
        )}
        {role !== "DOCTOR" && (
          <Button variant="outline" asChild>
            <Link href={`/print/statements/patients/${patientId}`} target="_blank">
              <PrinterIcon aria-hidden="true" />
              {dict.print.patientStatement}
            </Link>
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <EntryList
          title={dict.finance.charges}
          empty={dict.finance.emptyCharges}
          dateLabel={dict.finance.list.date}
          byLabel={dict.finance.list.by}
          entries={finance.charges}
          locale={locale}
        />
        <EntryList
          title={dict.finance.payments}
          empty={dict.finance.emptyPayments}
          dateLabel={dict.finance.list.date}
          byLabel={dict.finance.list.by}
          entries={finance.payments}
          locale={locale}
        />
      </div>
    </div>
  );
}

function entryExists(
  finance: Awaited<ReturnType<typeof getPatientFinance>>,
  currency: Currency
) {
  return (
    finance.charges.some((entry) => entry.currency === currency) ||
    finance.payments.some((entry) => entry.currency === currency)
  );
}

function EntryList({
  title,
  empty,
  dateLabel,
  byLabel,
  entries,
  locale,
}: {
  title: string;
  empty: string;
  dateLabel: string;
  byLabel: string;
  entries: Awaited<ReturnType<typeof getPatientFinance>>["charges"];
  locale: "ar" | "en";
}) {
  return (
    <section className="border-muted rounded-lg border">
      <h2 className="border-muted border-b px-3 py-2 text-sm font-medium">
        {title}
      </h2>
      {entries.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-sm">
          {empty}
        </p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="border-muted/60 flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-b-0"
            >
              <div className="min-w-0">
                <p className="font-medium tabular-nums" dir="ltr">
                  {formatMoney(
                    Math.round(parseFloat(entry.amount) * 100),
                    entry.currency as Currency,
                    locale
                  )}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {entry.description ?? "—"}
                </p>
              </div>
              <p className="text-muted-foreground shrink-0 text-xs">
                {dateLabel}: {formatZonedDate(new Date(entry.createdAt), locale)}
                {" · "}
                {byLabel}: {entry.byName}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
