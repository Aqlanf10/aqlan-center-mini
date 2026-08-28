import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import { getSettings, listTodayVisits } from "@/lib/db";
import { calledVisits, chairRows, firstNameOnly, waitingRows } from "@/lib/flow";

export const dynamic = "force-dynamic";


/**
 * ما تعرضه شاشة الصالة — وليس أكثر.
 *
 * هذا المسار عام بلا جلسة، لأن الشاشة معلّقة على تلفاز في صالة الانتظار ولا أحد
 * يسجّل الدخول عليها كل صباح. ولأنه عام، يُبنى الجواب هنا بما يُعرض فقط: الاسم الأول
 * ورقم الكرسي وعدد المنتظرين. لا هاتف ولا اسم كامل ولا رقم مريض ولا مُعرّف زيارة.
 *
 * الفلترة على الخادم لا في الواجهة: إرسال السجل كاملًا ثم إخفاء أجزائه بالعرض يترك
 * البيانات في استجابة يقرأها أي أحد بفتح أدوات المتصفح.
 */
export async function GET() {
  try {
    const [visits, settings] = await Promise.all([listTodayVisits(), getSettings()]);
    const chairs = chairCount(settings);
    const now = new Date();
    return NextResponse.json({
      called: calledVisits(visits).slice(0, 3).map((visit) => ({
        // `at` ليس بيانًا شخصيًا، ووجوده ضروري: الشاشة تميّز النداء الجديد من القديم به
        // لتصدر التنبيه الصوتي مرة واحدة. بلا مفتاح ثابت كانت ستُصدره كل خمس ثوانٍ.
        at: visit.calledAt,
        name: firstNameOnly(visit.patientName),
        chair: visit.chair,
      })),
      // الكرسي المحجوز بالنداء يُعرض «في الطريق» لا «فارغ»: المريض المنادى عليه يمشي
      // إليه الآن، وعرضه فارغًا يجعل الشاشة تناقض نداءها الظاهر فوقها.
      chairs: chairRows(chairs, visits, now).map((row) => ({
        chair: row.chair,
        state: row.occupant ? "busy" : row.calledFor ? "called" : "free",
        name: row.occupant
          ? firstNameOnly(row.occupant.patientName)
          : row.calledFor
            ? firstNameOnly(row.calledFor.patientName)
            : null,
      })),
      waiting: waitingRows(visits, now).length,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر التحميل." }, { status: 503 });
  }
}
