import Link from "next/link";
import { and, desc, eq, like } from "drizzle-orm";
import { eq as eqs } from "drizzle-orm";
import { FlaskConicalIcon, PrinterIcon } from "lucide-react";

import { db } from "@/lib/db";
import { patients, users } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UrlSearchInput } from "@/components/shared/url-search-input";
import { UrlFilterSelect } from "@/components/shared/url-filter-select";
import { LabDialog, LabActiveButton, LabInvoiceDialog } from "@/components/labs/lab-dialogs";
import { LabCaseDialog } from "@/components/labs/lab-case-dialog";
import { listLabs, listLabCases, getLabBalances } from "@/server/labs/labs";
import { listServices } from "@/server/services/catalog";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LabsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/labs");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const q = single(params.q)?.trim() ?? "";
  const status = single(params.status) ?? "";
  const labIdFilter = single(params.labId) ?? "";

  const labs = await listLabs(true);
  const balances = await getLabBalances();
  const services = await listServices();

  const doctors = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.role, "DOCTOR"), eq(users.active, true)))
    .limit(50);

  // Patient options: search-as-you-type is handled by the URL q param.
  const patientOptions = q
    ? await db
        .select({
          id: patients.id,
          fileNumber: patients.fileNumber,
          fullName: patients.fullName,
        })
        .from(patients)
        .where(and(eqs(patients.active, true), like(patients.fullName, `%${q}%`)))
        .orderBy(desc(patients.createdAt))
        .limit(30)
    : await db
        .select({
          id: patients.id,
          fileNumber: patients.fileNumber,
          fullName: patients.fullName,
        })
        .from(patients)
        .where(eqs(patients.active, true))
        .orderBy(desc(patients.createdAt))
        .limit(30);

  const cases = await listLabCases({
    labId: labIdFilter || undefined,
    status: status || undefined,
    limit: 100,
  });

  const filteredCases = q
    ? cases.filter(
        (row) =>
          row.caseNumber.toLowerCase().includes(q.toLowerCase()) ||
          row.patientName.includes(q) ||
          row.workType.includes(q)
      )
    : cases;

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.labs.title}
        subtitle={dict.labs.subtitle}
        actions={
          <LabCaseDialog
            source={{
              labs: labs
                .filter((lab) => lab.active)
                .map((lab) => ({ id: lab.id, label: lab.name })),
              patients: patientOptions.map((patient) => ({
                id: patient.id,
                label: `${patient.fullName} (${patient.fileNumber})`,
              })),
              doctors: doctors.map((doctor) => ({ id: doctor.id, label: doctor.name })),
              services: services.map((service) => ({
                id: service.id,
                label: `${service.code} — ${locale === "ar" ? service.nameAr : service.nameEn}`,
              })),
            }}
          />
        }
      />

      {/* Lab balances */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.labs.balances}</h2>
          <LabDialog buttonLabel={dict.labs.newLab} />
        </div>
        {labs.length === 0 ? (
          <EmptyState icon={FlaskConicalIcon} title={dict.labs.emptyLabs} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.fields.name}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.fields.phone}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.financeReports.invoiced}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.financeReports.paid}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.financeReports.balance}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.openCases}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {labs.map((lab) => {
                  const labBalances = balances.filter((row) => row.labId === lab.id);
                  return (
                    <tr key={lab.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-medium">{lab.name}</td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {lab.phone ?? dict.common.noValue}
                      </td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {labBalances.length === 0
                          ? dict.common.noValue
                          : labBalances
                              .map(
                                (row) =>
                                  `${formatMoney(row.invoicedMinor, row.currency, locale)}`
                              )
                              .join(" · ")}
                      </td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {labBalances.length === 0
                          ? dict.common.noValue
                          : labBalances
                              .map((row) => formatMoney(row.paidMinor, row.currency, locale))
                              .join(" · ")}
                      </td>
                      <td className="px-3 py-2.5 font-semibold" dir="ltr">
                        {labBalances.length === 0
                          ? dict.common.noValue
                          : labBalances
                              .map((row) => formatMoney(row.balanceMinor, row.currency, locale))
                              .join(" · ")}
                      </td>
                      <td className="px-3 py-2.5">
                        {labBalances.reduce((sum, row) => sum + row.openCases, 0)}
                        {labBalances.some((row) => row.overdueCases > 0) ? (
                          <Badge variant="destructive" className="ms-1">
                            {dict.labs.overdue}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <LabDialog
                            lab={{
                              id: lab.id,
                              name: lab.name,
                              phone: lab.phone,
                              address: lab.address,
                              notes: lab.notes,
                            }}
                            buttonLabel={dict.common.edit}
                          />
                          <LabActiveButton labId={lab.id} active={lab.active} />
                          {labBalances.length > 0 ? (
                            <Button variant="outline" size="sm" asChild>
                              <Link
                                href={`/print/statements/labs/${lab.id}`}
                                target="_blank"
                              >
                                <PrinterIcon aria-hidden="true" />
                                {dict.labs.statement}
                              </Link>
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cases */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{dict.labs.casesTitle}</h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <UrlSearchInput placeholder={dict.common.searchPlaceholder} />
          <UrlFilterSelect
            paramName="status"
            label={dict.common.status}
            anyLabel={dict.common.all}
            options={[
              { value: "ORDERED", label: dict.labs.statuses.ORDERED },
              { value: "SENT", label: dict.labs.statuses.SENT },
              { value: "RECEIVED", label: dict.labs.statuses.RECEIVED },
              { value: "DELIVERED", label: dict.labs.statuses.DELIVERED },
              { value: "CANCELLED", label: dict.labs.statuses.CANCELLED },
            ]}
          />
        </div>
        {filteredCases.length === 0 ? (
          <EmptyState icon={FlaskConicalIcon} title={dict.labs.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.number}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.lab}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.patient}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.workType}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.cost}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.status}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.labs.columns.invoiced}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredCases.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-mono text-xs" dir="ltr">
                      {row.caseNumber}
                    </td>
                    <td className="px-3 py-2.5">{row.labName}</td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/patients/${row.patientId}`}
                        className="text-primary hover:underline"
                      >
                        {row.patientName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">{row.workType}</td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {formatMoney(
                        Math.round(parseFloat(row.cost) * 100),
                        row.currency,
                        locale
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={row.status === "CANCELLED" ? "destructive" : "secondary"}>
                        {dict.labs.statuses[row.status as "ORDERED"]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs" dir="ltr">
                      {row.invoiced
                        ? `${row.invoiceNumber ?? "—"} · ${
                            row.invoiceAmount ?? row.cost
                          }`
                        : dict.common.no}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <LabInvoiceDialog
                          caseId={row.id}
                          caseNumber={row.caseNumber}
                          defaultAmount={row.cost}
                          invoiced={row.invoiced}
                        />
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
