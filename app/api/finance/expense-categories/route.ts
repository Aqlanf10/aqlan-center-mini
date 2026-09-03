import { NextRequest, NextResponse } from "next/server";
import {
  listExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  batchUpdateExpenseCategories,
  deleteExpenseCategory,
  syncExpenseCategoriesAccountingMapping,
  recordAudit,
} from "@/lib/db";
import { STANDARD_EXPENSE_ACCOUNTS } from "@/lib/accounting";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: NextRequest) {
  const session = await requireSession();
  if (!session) return denied();

  try {
    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month") || undefined;
    const includeInactive = searchParams.get("includeInactive") === "true";

    const { categories, summary } = await listExpenseCategories({
      month,
      includeInactive,
    });

    return NextResponse.json({
      categories,
      summary,
      standardExpenseAccounts: STANDARD_EXPENSE_ACCOUNTS,
      baseCurrency: CLINIC_BASE_CURRENCY,
    });
  } catch (error) {
    console.error("Failed to load expense categories:", error);
    return NextResponse.json(
      { message: "تعذّر تحميل بنود المصروفات التشغيلية والميزانيات." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role) && session.role !== "accountant") {
    return NextResponse.json(
      { message: "هذا الإجراء يتطلب صلاحية المدير العام أو المحاسب." },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();

    // دعم إجراء المزامنة والضبط الآلي للربط المحاسبي
    if (body.action === "sync_accounting" || body.action === "ensure_all_linked") {
      const syncResult = await syncExpenseCategoriesAccountingMapping();
      await recordAudit({
        actor: session.username,
        actorRole: session.role,
        action: "settings.update",
        entity: "expense_categories",
        entityLabel: "ضبط الربط المحاسبي التلقائي لبنود المصروفات",
        details: {
          action: "sync_accounting",
          fixedCount: syncResult.fixedCount,
          totalSynced: syncResult.totalSynced,
        },
      });

      return NextResponse.json({
        ok: true,
        message: `تم ضبط وتأكيد الربط المحاسبي لـ ${syncResult.totalSynced} بنداً مع تفعيل الترحيل التلقائي.`,
        fixedCount: syncResult.fixedCount,
        totalSynced: syncResult.totalSynced,
        categories: syncResult.categories,
      });
    }

    const name = (body.name || "").trim();
    const accountCode = (body.accountCode || "").trim();
    if (!name) {
      return NextResponse.json(
        { message: "اسم بند المصروف مطلوب." },
        { status: 400 },
      );
    }
    if (!accountCode) {
      return NextResponse.json(
        { message: "كود الحساب بدليل الحسابات مطلوب." },
        { status: 400 },
      );
    }

    const created = await createExpenseCategory({
      key: body.key,
      name,
      categoryGroup: body.categoryGroup,
      accountCode,
      monthlyBudgetMinor: Number(body.monthlyBudgetMinor) || 0,
      annualBudgetMinor: Number(body.annualBudgetMinor) || 0,
      budgetCurrency: body.budgetCurrency || CLINIC_BASE_CURRENCY,
      autoPostJournal: body.autoPostJournal !== false,
      description: body.description,
      displayOrder: Number(body.displayOrder) || 50,
    });

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "settings.update",
      entity: "expense_categories",
      entityLabel: created.name,
      details: {
        operation: "create",
        name: created.name,
        accountCode: created.accountCode,
        autoPostJournal: created.autoPostJournal,
        monthlyBudgetMinor: created.monthlyBudgetMinor,
      },
    });

    return NextResponse.json({ ok: true, category: created });
  } catch (error: any) {
    console.error("Failed to create expense category:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر إنشاء بند المصروف التشغيلي." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role) && session.role !== "accountant") {
    return NextResponse.json(
      { message: "هذا الإجراء يتطلب صلاحية المدير العام أو المحاسب." },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();

    // دعم الحفظ الجماعي (Batch Update)
    if (Array.isArray(body.updates)) {
      const result = await batchUpdateExpenseCategories(body.updates);
      await recordAudit({
        actor: session.username,
        actorRole: session.role,
        action: "settings.update",
        entity: "expense_categories",
        entityLabel: `تحديث ${result.updatedCount} بنداً`,
        details: {
          batchCount: result.updatedCount,
        },
      });
      return NextResponse.json({ ok: true, updatedCount: result.updatedCount });
    }

    // تحديث بند منفرد
    const id = Number(body.id);
    if (!id || id <= 0) {
      return NextResponse.json({ message: "معرف البند غير صحيح." }, { status: 400 });
    }

    const success = await updateExpenseCategory(id, {
      name: body.name,
      categoryGroup: body.categoryGroup,
      accountCode: body.accountCode,
      monthlyBudgetMinor: body.monthlyBudgetMinor !== undefined ? Number(body.monthlyBudgetMinor) : undefined,
      annualBudgetMinor: body.annualBudgetMinor !== undefined ? Number(body.annualBudgetMinor) : undefined,
      budgetCurrency: body.budgetCurrency,
      isActive: body.isActive,
      autoPostJournal: body.autoPostJournal,
      description: body.description,
      displayOrder: body.displayOrder !== undefined ? Number(body.displayOrder) : undefined,
    });

    if (!success) {
      return NextResponse.json({ message: "لم يتم العثور على البند المطلوب تحديثه." }, { status: 404 });
    }

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "settings.update",
      entity: "expense_categories",
      entityId: id,
      entityLabel: body.name || `بند #${id}`,
      details: {
        id,
        name: body.name,
        accountCode: body.accountCode,
        autoPostJournal: body.autoPostJournal,
        monthlyBudgetMinor: body.monthlyBudgetMinor,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Failed to update expense category:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر حفظ تعديلات بند المصروف." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role) && session.role !== "accountant") {
    return NextResponse.json(
      { message: "هذا الإجراء يتطلب صلاحية المدير العام أو المحاسب." },
      { status: 403 },
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = Number(searchParams.get("id"));
    if (!id || id <= 0) {
      return NextResponse.json({ message: "معرف البند غير صحيح." }, { status: 400 });
    }

    const result = await deleteExpenseCategory(id);
    if (!result.success) {
      return NextResponse.json({ message: "تعذّر حذف أو تعطيل البند." }, { status: 404 });
    }

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "settings.update",
      entity: "expense_categories",
      entityId: id,
      entityLabel: `بند #${id}`,
      details: {
        deactivated: result.deactivated,
      },
    });

    return NextResponse.json({ ok: true, deactivated: result.deactivated });
  } catch (error: any) {
    console.error("Failed to delete expense category:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر حذف بند المصروف." },
      { status: 500 },
    );
  }
}
