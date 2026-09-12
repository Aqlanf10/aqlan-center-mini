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
  try {
    return NextResponse.json(await listSettingHistory({
      key: text("key"), category: text("category"), actor: text("actor"),
      from: text("from"), to: text("to"),
      limit: Number(url.searchParams.get("limit") ?? 100),
    }));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجلّ الإعدادات." }, { status: 500 });
  }
}
