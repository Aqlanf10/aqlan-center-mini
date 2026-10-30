import { NextResponse } from "next/server";
import {
  activeAnnouncementsForScreen,
  getSettings,
  listTodayVisits,
} from "@/lib/db";
import { calledVisits } from "@/lib/flow";
import { projectWaitingRoomDisplay } from "@/lib/waiting-room";
import { currentStaffEntryMode } from "@/lib/staff-entry-mode";
import { readPublicDisplaySnapshot } from "@/lib/display-snapshot";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * ما تعرضه شاشة الصالة — وليس أكثر.
 *
 * هذا المسار عام بلا جلسة، لأن الشاشة معلّقة على تلفاز في صالة الانتظار ولا أحد
 * يسجّل الدخول عليها كل صباح. ولأنه عام، يُبنى الجواب هنا بما يُعرض فقط: أسماء
 * النداء الجاري المقنّع ووجهته فقط؛ بلا صف أو كراسٍ مشغولة أو مؤشرات عمل. لا هاتف
 * ولا ملاحظة ولا تشخيص ولا حساب ولا
 * حتى مُعرّف مريض — الفلترة على الخادم لا في الواجهة: إرسال السجل كاملًا ثم
 * إخفاء أجزائه بالعرض يترك البيانات في استجابة يقرأها أي أحد بفتح أدوات
 * المتصفح.
 *
 * القناع يُقرأ من الإعدادات (display.privacy_mode) فيُطبَّق قبل أن يغادر الاسم
 * الخادم: «أحمد م.» افتراضيًا، أو الاسم الأول وحده لمن يختار الاختصار الأقصى.
 */
export async function GET() {
  try {
    // Public admission is unchanged. A marked clinic uses only non-initializing
    // snapshot readers; failure never falls back to the legacy migration path.
    if (await currentStaffEntryMode() === "canonical") {
      return NextResponse.json(await readPublicDisplaySnapshot(), { headers: NO_STORE });
    }
    const now = new Date();
    const [visits, settings, announcements] = await Promise.all([
      listTodayVisits(),
      getSettings(),
      // الإعلانات من سجلاتها المنظّمة: المفعّل وحده بترتيبه، عنوانًا ونصًّا لا
      // أكثر — ولا فرقًا في شكل الجواب عمّا كانت تعيده الخانة القديمة.
      activeAnnouncementsForScreen(),
    ]);

    return NextResponse.json(projectWaitingRoomDisplay({ now, calls: calledVisits(visits), settings, announcements }), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "تعذّر التحميل." }, { status: 503, headers: NO_STORE });
  }
}
