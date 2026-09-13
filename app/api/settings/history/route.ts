import { NextResponse } from "next/server";
import { listSettingHistory } from "@/lib/db";
import { roleCan } from "@/lib/settings-permissions";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * سجلّ تغييرات الإعدادات المركزية.
 *
 * يُستخرج بتمييزٍ مزدوج (`entity = clinic_setting` مع فعلٍ من عائلة
 * `clinic_settings.*`)، فلا يختلط بأفعال المختبرات التي تستعمل الاسم القديم
 * `settings.update`. والسرّ يظهر بحالته المعنوية لا بقيمته — لأن قيمته لم تُكتب أصلًا.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!roleCan(session.role, "settings.view_history")) {
    return NextResponse.json({ message: "سجلّ الإعدادات للمدير وحده." }, { status: 403 });
  }
  const url = new URL(request.url);
  const text = (name: string): string | null => {
    const value = url.searchParams.get(name);
    return value && value.trim() ? value.trim() : null;
  };
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const beforeId = text("beforeId");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500
    || (beforeId !== null && !/^[1-9]\d{0,18}$/.test(beforeId))
    || [text("from"), text("to")].some((date) => date !== null
      && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))))) {
    return NextResponse.json({ message: "مرشحات السجل غير صالحة." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listSettingHistory({
      key: text("key"), category: text("category"), actor: text("actor"),
      from: text("from"), to: text("to"),
      limit, beforeId, action: text("action"),
    }));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجلّ الإعدادات." }, { status: 500 });
  }
}
