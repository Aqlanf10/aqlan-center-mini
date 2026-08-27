import { SettingsIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  ServiceActiveButton,
  ServiceCategoryActiveButton,
  ServiceCategoryDialog,
  ServiceDialog,
} from "@/components/services/service-dialogs";
import { listServiceCategories, listServices } from "@/server/services/catalog";

export const dynamic = "force-dynamic";

export default async function ServicesCatalogPage() {
  await requireRole(["ADMIN"], "/settings/services");
  const { locale, dict } = await getI18n();

  const categories = await listServiceCategories(true);
  const services = await listServices({ includeArchived: true });

  const categoryLabels = categories
    .filter((category) => category.active)
    .map((category) => ({
      id: category.id,
      label: locale === "ar" ? category.nameAr : category.nameEn,
    }));

  return (
    <div className="space-y-8">
      <PageHeader title={dict.services.title} subtitle={dict.services.subtitle} />

      {/* Categories */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.services.categoriesTitle}</h2>
          <ServiceCategoryDialog />
        </div>
        {categories.length === 0 ? (
          <EmptyState icon={SettingsIcon} title={dict.services.emptyCategories} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.nameAr}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.suppliers.fields.nameEn}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.fields.sortOrder}
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
                {categories.map((category) => (
                  <tr key={category.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-medium">{category.nameAr}</td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {category.nameEn}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {category.sortOrder}
                    </td>
                    <td className="px-3 py-2.5">
                      {category.active ? (
                        <Badge variant="secondary">{dict.common.active}</Badge>
                      ) : (
                        <Badge variant="outline">{dict.common.inactive}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ServiceCategoryDialog
                          category={{
                            id: category.id,
                            nameAr: category.nameAr,
                            nameEn: category.nameEn,
                            sortOrder: category.sortOrder,
                          }}
                        />
                        <ServiceCategoryActiveButton
                          categoryId={category.id}
                          active={category.active}
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

      {/* Services */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{dict.services.title}</h2>
          <ServiceDialog categories={categoryLabels} />
        </div>
        {services.length === 0 ? (
          <EmptyState icon={SettingsIcon} title={dict.services.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.columns.code}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.columns.name}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.columns.category}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.columns.price}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.columns.commission}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.services.columns.status}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-mono text-xs" dir="ltr">
                      {service.code}
                    </td>
                    <td className="px-3 py-2.5 font-medium">
                      {locale === "ar" ? service.nameAr : service.nameEn}
                    </td>
                    <td className="px-3 py-2.5">
                      {service.categoryId
                        ? locale === "ar"
                          ? service.categoryNameAr
                          : service.categoryNameEn
                        : dict.common.noValue}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {service.defaultPrice
                        ? formatMoney(
                            Math.round(parseFloat(service.defaultPrice) * 100),
                            service.currency,
                            locale
                          )
                        : dict.common.noValue}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {service.commissionEligible ? (
                        <span>
                          {service.defaultCommissionType
                            ? `${dict.services.commissionTypes[service.defaultCommissionType]} ${service.defaultCommissionValue ?? ""}`
                            : dict.common.yes}
                        </span>
                      ) : (
                        dict.common.no
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {service.active ? (
                        <Badge variant="secondary">{dict.common.active}</Badge>
                      ) : (
                        <Badge variant="outline">{dict.services.archived}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ServiceDialog
                          categories={categoryLabels}
                          service={{
                            id: service.id,
                            code: service.code,
                            nameAr: service.nameAr,
                            nameEn: service.nameEn,
                            categoryId: service.categoryId ?? "",
                            defaultPrice: service.defaultPrice ?? "",
                            currency: service.currency,
                            commissionEligible: service.commissionEligible ? "yes" : "no",
                            defaultCommissionType: service.defaultCommissionType ?? "",
                            defaultCommissionValue: service.defaultCommissionValue ?? "",
                          }}
                        />
                        <ServiceActiveButton
                          serviceId={service.id}
                          active={service.active}
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
