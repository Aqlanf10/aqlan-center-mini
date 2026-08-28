import { TagIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  ExpenseCategoryActiveButton,
  ExpenseCategoryDialog,
} from "@/components/finance/account-dialogs";
import { listExpenseCategories } from "@/server/finance/accounts";

export const dynamic = "force-dynamic";

export default async function ExpenseCategoriesPage() {
  await requireRole(["ADMIN"], "/finance/expense-categories");
  const { dict } = await getI18n();

  const categories = await listExpenseCategories(true);

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.financeAccounts.expenseCategoriesTitle}
        subtitle={dict.financeAccounts.expenseCategoriesSubtitle}
        actions={
          <ExpenseCategoryDialog buttonLabel={dict.financeAccounts.newCategory} />
        }
      />

      {categories.length === 0 ? (
        <EmptyState
          icon={TagIcon}
          title={dict.financeAccounts.emptyCategories}
          description={dict.financeAccounts.expenseCategoriesSubtitle}
        />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-muted-foreground bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeAccounts.fieldsCategory.nameAr}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeAccounts.fieldsCategory.nameEn}
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
                  <td className="px-3 py-2.5">
                    {category.active ? (
                      <Badge variant="secondary">{dict.common.active}</Badge>
                    ) : (
                      <Badge variant="outline">{dict.common.inactive}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ExpenseCategoryDialog
                        category={{
                          id: category.id,
                          nameAr: category.nameAr,
                          nameEn: category.nameEn,
                        }}
                        buttonLabel={dict.common.edit}
                      />
                      <ExpenseCategoryActiveButton
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
    </div>
  );
}
