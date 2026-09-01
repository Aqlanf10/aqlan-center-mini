import { NextResponse } from "next/server";
import {
  activeAnnouncementsForScreen,
  CLINIC_TIME_ZONE,
  getSettings,
  listAppointmentsByDate,
  listOrthoActivePatientIds,
  listTodayVisits,
} from "@/lib/db";
import { chairCount } from "@/lib/settings";
import { calledVisits, chairRows, firstNameOnly, waitingRows } from "@/lib/flow";
import { clinicDateString } from "@/lib/schedule";
import {
  averageWaitMinutes,
  DEFAULT_TAGLINE,
  maskName,
  orthoSessionsToday,
  waitingRoomQueue,
  type PrivacyMode,
} from "@/lib/waiting-room";

export const dynamic = "force-dynamic";

/**
 * ما تعرضه شاشة الصالة — وليس أكثر.
 *
 * هذا المسار عام بلا جلسة، لأن الشاشة معلّقة على تلفاز في صالة الانتظار ولا أحد
 * يسجّل الدخول عليها كل صباح. ولأنه عام، يُبنى الجواب هنا بما يُعرض فقط: أسماء
 * مُقنَّعة، وأوقات، وحالات، وأعداد. لا هاتف ولا ملاحظة ولا تشخيص ولا حساب ولا
 * حتى مُعرّف مريض — الفلترة على الخادم لا في الواجهة: إرسال السجل كاملًا ثم
 * إخفاء أجزائه بالعرض يترك البيانات في استجابة يقرأها أي أحد بفتح أدوات
 * المتصفح.
 *
 * القناع يُقرأ من الإعدادات (display.privacy_mode) فيُطبَّق قبل أن يغادر الاسم
 * الخادم: «أحمد م.» افتراضيًا، أو الاسم الأول وحده لمن يختار الاختصار الأقصى.
 */
export async function GET() {
  try {
    const now = new Date();
    const [visits, appointments, settings, orthoPatientIds, announcements] = await Promise.all([
      listTodayVisits(),
      listAppointmentsByDate(clinicDateString(now, CLINIC_TIME_ZONE)),
      getSettings(),
      listOrthoActivePatientIds(),
      // الإعلانات من سجلاتها المنظّمة: المفعّل وحده بترتيبه، عنوانًا ونصًّا لا
      // أكثر — ولا فرقًا في شكل الجواب عمّا كانت تعيده الخانة القديمة.
      activeAnnouncementsForScreen(),
    ]);

    const privacy = (settings["display.privacy_mode"] === "first_only"
      ? "first_only"
      : "first_initial") as PrivacyMode;
    const chairs = chairCount(settings);

    const waitingCount = waitingRows(visits, now).length;
    const inTreatment = visits.filter((visit) => visit.status === "in_chair").length;
    const doneCount = visits.filter((visit) => visit.status === "done").length;
    const avgWait = averageWaitMinutes(visits);
    const ortho = settings["display.show_ortho"] === "false" ? null : orthoSessionsToday(appointments, orthoPatientIds);

    return NextResponse.json({
      now: now.toISOString(),
      called: calledVisits(visits).slice(0, 3).map((visit) => ({
        // `at` ليس بيانًا شخصيًا، ووجوده ضروري: الشاشة تميّز النداء الجديد من
        // القديم به لتصدر النغمة والنطق مرة واحدة — وإعادة النداء تحدّثه فتصدر
        // من جديد بلا ضغطة ثانية على التلفاز.
        at: visit.calledAt,
        name: maskName(visit.patientName, privacy),
        // النطق بالاسم الأول فقط كما يُنادى به في الصالة أصلًا: نطق «أحمد م.»
        // يُخرج «ميم» من آلة النطق، والاسم الأول هو ما يتجاوب معه المريض.
        speechName: firstNameOnly(visit.patientName),
        chair: visit.chair,
      })),
      // الكرسي المحجوز بالنداء يُعرض «في الطريق» لا «فارغ»: المريض المنادى عليه
      // يمشي إليه الآن، وعرضه فارغًا يجعل الشاشة تناقض نداءها الظاهر فوقها.
      chairs: chairRows(chairs, visits, now).map((row) => ({
        chair: row.chair,
        state: row.occupant ? "busy" : row.calledFor ? "called" : "free",
        name: row.occupant
          ? maskName(row.occupant.patientName, privacy)
          : row.calledFor
            ? maskName(row.calledFor.patientName, privacy)
            : null,
      })),
      queue: waitingRoomQueue({
        visits,
        appointments,
        privacy,
        timeZone: CLINIC_TIME_ZONE,
      }),
      stats: {
        waiting: waitingCount,
        inTreatment,
        done: doneCount,
        // متوسط الانتظار الفعلي اليوم — والغياب يعني «لا قياس بعد» لا صفرًا.
        avgWaitMinutes: avgWait,
        ortho,
      },
      // رسالة الاعتذار يشغّلها الاستقبال بضغطة من لوحة اليوم — شريطٌ لطيف يفسّر
      // التأخير بدل أن يبقى المرضى متضايقين بلا تفسير.
      delayNotice: settings["display.delay_notice"] === "true",
      // النطق الصوتي يُقرأ من الإعدادات، والتشغيل الفعلي يبقى رهنًا بضغطة
      // «تشغيل صوت النداء» على التلفاز نفسه — سياسة المتصفح لا رغبةُنا.
      voice: settings["display.voice"] !== "false",
      announcements,
      welcomeText: `مرحبًا بكم في ${settings["clinic.name"]}`,
      tagline: settings["display.tagline"] || DEFAULT_TAGLINE,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر التحميل." }, { status: 503 });
  }
}
