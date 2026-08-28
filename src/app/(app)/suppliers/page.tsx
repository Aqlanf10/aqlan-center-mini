import Link from "next/link";
import { PackageIcon, PrinterIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MaterialActiveButton,
  MaterialDialog,
  PurchaseInvoiceDialog,
  SupplierActiveButton,
  SupplierDialog,
  CancelInvoiceButton,
} from "@/components/suppliers/supplier-dialogs";
import {
  getSupplierBalances,
  listMaterials,
  listPurchaseInvoices,
  listSuppliers,
} from "@/server/suppliers/suppliers";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  await requireRole(["ADMIN"], "/suppliers");
  const { locale, dict } = await getI18n();

  const suppliers = await listSuppliers(true);
  const materials = await listMaterials(true);
  const balances = await getSupplierBalances();
  const invoices = await listPurchaseInvoices({ limit: 100 });

  const supplierLabels = suppliers
    .filter((supplier) => supplier.active)
    .map((supplier) => ({ id: supplier.id, label: supplier.name }));
  const materialLabels = materials
    .filter((material) => material.active)
    .map((material) => ({
      id: material.id,
      label: `${material.code} — ${locale === "ar" ? material.nameAr : material.nameEn}`,
    }));

  return (
    <div className="space-y-8">
      <PageHeader
        title={dict.suppliers.title}
        subtitle={dict.suppliers.subtitle}
      />

      {/* Suppliers */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.suppliers.suppliersTab}</h2>
          <SupplierDialog buttonLabel={dict.suppliers.newSupplier} />
        </div>
        {suppliers.length === 0 ? (
          <EmptyState icon={PackageIcon} title={dict.suppliers.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.name}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.phone}
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
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => {
                  const supplierBalances = balances.filter(
                    (row) => row.supplierId === supplier.id
                  );
                  return (
                    <tr key={supplier.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-medium">{supplier.name}</td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {supplier.phone ?? dict.common.noValue}
                      </td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {supplierBalances.length === 0
                          ? dict.common.noValue
                          : supplierBalances
                              .map((row) => formatMoney(row.invoicedMinor, row.currency, locale))
                              .join(" · ")}
                      </td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {supplierBalances.length === 0
                          ? dict.common.noValue
                          : supplierBalances
                              .map((row) => formatMoney(row.paidMinor, row.currency, locale))
                              .join(" · ")}
                      </td>
                      <td className="px-3 py-2.5 font-semibold" dir="ltr">
                        {supplierBalances.length === 0
                          ? dict.common.noValue
                          : supplierBalances
                              .map((row) => formatMoney(row.balanceMinor, row.currency, locale))
                              .join(" · ")}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <SupplierDialog
                            supplier={{
                              id: supplier.id,
                              name: supplier.name,
                              phone: supplier.phone,
                              address: supplier.address,
                              notes: supplier.notes,
                            }}
                            buttonLabel={dict.common.edit}
                          />
                          <SupplierActiveButton
                            supplierId={supplier.id}
                            active={supplier.active}
                          />
                          {supplierBalances.length > 0 ? (
                            <Button variant="outline" size="sm" asChild>
                              <Link
                                href={`/print/statements/suppliers/${supplier.id}`}
                                target="_blank"
                              >
                                <PrinterIcon aria-hidden="true" />
                                {dict.suppliers.statement}
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

      {/* Materials */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.suppliers.materialsTab}</h2>
          <MaterialDialog suppliers={supplierLabels} buttonLabel={dict.suppliers.newMaterial} />
        </div>
        {materials.length === 0 ? (
          <EmptyState icon={PackageIcon} title={dict.suppliers.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.code}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.nameAr}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.nameEn}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.unit}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.defaultSupplier}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {materials.map((material) => (
                  <tr key={material.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-mono text-xs" dir="ltr">
                      {material.code}
                    </td>
                    <td className="px-3 py-2.5">{material.nameAr}</td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {material.nameEn}
                    </td>
                    <td className="px-3 py-2.5">{material.unit ?? dict.common.noValue}</td>
                    <td className="px-3 py-2.5">
                      {material.defaultSupplierName ?? dict.common.noValue}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <MaterialDialog
                          suppliers={supplierLabels}
                          material={{
                            id: material.id,
                            code: material.code,
                            nameAr: material.nameAr,
                            nameEn: material.nameEn,
                            unit: material.unit,
                            defaultSupplierId: material.defaultSupplierId,
                          }}
                          buttonLabel={dict.common.edit}
                        />
                        <MaterialActiveButton
                          materialId={material.id}
                          active={material.active}
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

      {/* Purchase invoices */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.suppliers.invoicesTab}</h2>
          <PurchaseInvoiceDialog suppliers={supplierLabels} materials={materialLabels} />
        </div>
        {invoices.length === 0 ? (
          <EmptyState icon={PackageIcon} title={dict.suppliers.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.number}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.supplier}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.date}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.total}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.paid}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.balance}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.columns.status}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => {
                  const paidMinor = Math.round(parseFloat(invoice.paidMinor ?? "0") * 100);
                  const totalMinor = Math.round(parseFloat(invoice.totalAmount) * 100);
                  return (
                    <tr key={invoice.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-mono text-xs" dir="ltr">
                        {invoice.invoiceNumber}
                      </td>
                      <td className="px-3 py-2.5">{invoice.supplierName}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {formatZonedDate(invoice.invoiceDate, locale)}
                      </td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {formatMoney(totalMinor, invoice.currency, locale)}
                      </td>
                      <td className="px-3 py-2.5" dir="ltr">
                        {formatMoney(paidMinor, invoice.currency, locale)}
                      </td>
                      <td className="px-3 py-2.5 font-semibold" dir="ltr">
                        {formatMoney(totalMinor - paidMinor, invoice.currency, locale)}
                      </td>
                      <td className="px-3 py-2.5">
                        {invoice.status === "CANCELLED" ? (
                          <Badge variant="destructive">{dict.statuses.appointment.CANCELLED}</Badge>
                        ) : (
                          <Badge variant="secondary">{dict.financeVouchers.active}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {invoice.status === "ACTIVE" ? (
                          <CancelInvoiceButton invoiceId={invoice.id} />
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {invoice.cancelReason ?? ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
