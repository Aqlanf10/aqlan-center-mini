import { NextResponse } from "next/server";
import {
  listLabAccountingMappings,
  updateLabAccountingMapping,
  batchUpdateLabAccountingMappings,
  recordAudit,
  getLaboratory,
} from "@/lib/db";
import {
  STANDARD_LAB_EXPENSE_ACCOUNTS,
  STANDARD_LAB_PAYABLE_ACCOUNTS,
  getAccountName,
} from "@/lib/accounting";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "حسابات المختبرات للإدارة والمصرح لهم بالمالية فقط." }, { status: 403 });
  }

  try {
    const mappings = await listLabAccountingMappings();

    const summary = {
      totalLabs: mappings.length,
      activeLabs: mappings.filter((m) => m.isActive).length,
      totalOwedMinor: mappings.reduce((sum, m) => sum + m.totalOwedMinor, 0),
      totalPaidMinor: mappings.reduce((sum, m) => sum + m.totalPaidMinor, 0),
      totalDueMinor: mappings.reduce((sum, m) => sum + m.dueMinor, 0),
      activeOrdersTotal: mappings.reduce((sum, m) => sum + m.activeOrdersCount, 0),
      customMappedCount: mappings.filter(
        (m) => m.expenseAccountCode !== "5101" || m.payableAccountCode !== "2101",
      ).length,
    };

    return NextResponse.json({
      mappings,
      standardExpenseAccounts: STANDARD_LAB_EXPENSE_ACCOUNTS,
      standardPayableAccounts: STANDARD_LAB_PAYABLE_ACCOUNTS,
      summary,
    });
  } catch (error) {
    console.error("Failed to load lab accounting mappings:", error);
    return NextResponse.json(
      { message: "تعذّر تحميل إعدادات الحسابات للمختبرات." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json(
      { message: "تعديل شجرة الحسابات والربط المالي للمدير وحده." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;

  // دعم التحديث الجماعي (Batch update)
  if (Array.isArray(source.updates)) {
    const updates = source.updates.map((u: Record<string, unknown>) => ({
      id: Number(u.id),
      expenseAccountCode: typeof u.expenseAccountCode === "string" ? u.expenseAccountCode.trim() : undefined,
      payableAccountCode: typeof u.payableAccountCode === "string" ? u.payableAccountCode.trim() : undefined,
      autoPostJournal: typeof u.autoPostJournal === "boolean" ? u.autoPostJournal : undefined,
      customAccountName: typeof u.customAccountName === "string" ? u.customAccountName.trim() : (u.customAccountName === null ? null : undefined),
    })).filter((u) => Number.isInteger(u.id) && u.id > 0);

    if (updates.length === 0) {
      return NextResponse.json({ message: "لا توجد تعديلات صالحة للتطبيق." }, { status: 400 });
    }

    try {
      const result = await batchUpdateLabAccountingMappings(updates);

      await recordAudit({
        action: "settings.update",
        actor: session.username,
        details: {
          entity: "lab_accounting_mappings",
          count: result.updatedCount,
          message: `تحديث جماعي لربط الحسابات لعدد ${result.updatedCount} مختبر`,
        },
      });

      const refreshed = await listLabAccountingMappings();
      return NextResponse.json({ ok: true, updatedCount: result.updatedCount, mappings: refreshed });
    } catch (error) {
      console.error("Failed to batch update lab accounting:", error);
      return NextResponse.json({ message: "تعذّر حفظ التحديثات الجماعية." }, { status: 500 });
    }
  }

  // تحديث مختبر واحد
  const id = Number(source.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف المختبر غير صالح." }, { status: 400 });
  }

  const expenseCode = typeof source.expenseAccountCode === "string" ? source.expenseAccountCode.trim() : undefined;
  const payableCode = typeof source.payableAccountCode === "string" ? source.payableAccountCode.trim() : undefined;
  const autoPost = typeof source.autoPostJournal === "boolean" ? source.autoPostJournal : undefined;
  const customName = typeof source.customAccountName === "string"
    ? source.customAccountName.trim()
    : source.customAccountName === null
    ? null
    : undefined;

  try {
    const lab = await getLaboratory(id);
    if (!lab) {
      return NextResponse.json({ message: "المختبر غير موجود." }, { status: 404 });
    }

    const success = await updateLabAccountingMapping(id, {
      expenseAccountCode: expenseCode,
      payableAccountCode: payableCode,
      autoPostJournal: autoPost,
      customAccountName: customName,
    });

    if (!success) {
      return NextResponse.json({ message: "تعذّر حفظ التعديلات." }, { status: 500 });
    }

    await recordAudit({
      action: "settings.update",
      actor: session.username,
      details: {
        entity: "lab_accounting_mapping",
        id,
        labName: lab.name,
        expenseAccount: expenseCode ? `${expenseCode} (${getAccountName(expenseCode)})` : undefined,
        payableAccount: payableCode ? `${payableCode} (${getAccountName(payableCode)})` : undefined,
        autoPostJournal: autoPost,
        message: `تحديث ربط الحسابات للمختبر: ${lab.name} (حساب المصروف: ${expenseCode ?? lab.expenseAccountCode})`,
      },
    });

    const refreshed = await listLabAccountingMappings();
    return NextResponse.json({ ok: true, mappings: refreshed });
  } catch (error) {
    console.error("Failed to update lab accounting mapping:", error);
    return NextResponse.json({ message: "تعذّر حفظ التعديلات." }, { status: 500 });
  }
}
