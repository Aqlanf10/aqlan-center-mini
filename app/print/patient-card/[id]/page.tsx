import { notFound } from "next/navigation";
import {
  CLINIC_TIME_ZONE, getPatient, getSettingsSafe, patientAppointmentsFrom,
} from "@/lib/db";
import { upcomingAppointments } from "@/lib/patientCard";
import { clinicDateString } from "@/lib/schedule";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * بطاقة المريض — ربع ورقة A6 تخرج بيده فيها رقمُ ملفّه وموعدُه القادم.
 * (منقولة من مستودع الوكيل الآخر لمكوّناتنا.)
 *
 * تحلّ **الزحمة** بعينها: المريض يأتي فلا يذكر رقم ملفّه ولا موعده، فيقف عند
 * الاستقبال بينما يُبحث عن اسمه بين المتشابهين — و«محمد أحمد» في تعز ليس واحدًا.
 * وبطاقةٌ في جيبه تختصر البحث إلى رقم.
 *
 * **وهي عكس الوصفة عمدًا.** الوصفة تُجمَّد لحظة إصدارها لأنها وثيقةٌ يُصرف بها
 * دواء. أما البطاقة فقيمتها كلُّها في أنها **تقول الحال الآن**: موعدٌ نُقل بعد
 * طبعها يجعل الورقة القديمة خطأً، فلا تُجمَّد — تُبنى عند كل طبعة من الملف الحيّ،
 * **وتحمل تاريخ طبعها** فبطاقةٌ بلا تاريخٍ تُقرأ بعد ستة أشهر على أنها اليوم.
 *
 * **ولا تحمل تشخيصًا ولا مبلغًا ولا تنبيهًا طبيًّا.** ورقةٌ تُحمل في جيبٍ وتُنسى
 * على طاولة، ووضعُ حساسيةِ المريض أو رصيده عليها إفشاءٌ لا يحتاجه غرضُها.
 * **ولا تحمل رابط البوّابة**: الدخول إليها رقمُ الجوال ورقمُ الملف، والبطاقة
 * تحمل الاثنين — فالرابط المطبوع يجعلها مفتاحًا كاملًا لمن يجدها.
 */
export default async function PatientCardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const [patient, settings] = await Promise.all([getPatient(id), getSettingsSafe()]);
  // ومريضٌ لا وجود له ٤٠٤، لا بطاقةً باسمٍ فارغ على ترويسة المركز.
  if (!patient) notFound();
  /* حرس الباب (P0.12): صفحة الطباعة تتحقق بنفسها من ملكية المريض — لا
   * تعتمد على الوكيل العام الذي يمرر /print/*. */
  if (!(await canAccessPatient(session, id).catch(() => false))) notFound();


  const next = upcomingAppointments(await patientAppointmentsFrom(id, today), today);

  return (
    <>
      {/* ولا علامةَ «نسخة معاد طباعتها»: إعادةُ طبع بطاقةٍ ضاعت من مريضٍ أمرٌ
          عاديٌّ يوميّ، ووسمُها بعلامةٍ معناها «احذر، صدرت من قبل» يُفرغ العلامة
          من معناها في الأوراق المالية التي وُضعت لها. */}
      <PrintButton />
      <div className="sheet sheet-a6">
        <PrintHeader settings={settings} title="بطاقة المريض" compact />

        <p className="amount-box" dir="ltr">{patient.patientNumber}</p>
        <p style={{ textAlign: "center", fontWeight: 800, fontSize: "13pt", margin: "2mm 0 3mm" }}>
          {patient.fullName}
        </p>

        <div className="rule-light" />
        <div className="line">
          <span>الهاتف</span>
          <span className="num" dir="ltr">{patient.phone ?? "—"}</span>
        </div>
        <div className="line">
          <span>تاريخ التسجيل</span>
          {/* وبتوقيت العيادة كتاريخ الطبع تمامًا: `createdAt` طابعٌ بتوقيت غرينتش،
              وقصُّ عشرة أحرفٍ منه يعطي اليوم السابق لمن سُجّل بين منتصف الليل
              والثالثة فجرًا. */}
          <span>{friendlyDateLong(clinicDateString(new Date(patient.createdAt), CLINIC_TIME_ZONE))}</span>
        </div>

        <div className="rule-light" />
        <p style={{ fontWeight: 800, fontSize: "10pt", margin: "2mm 0 1mm" }}>مواعيدك القادمة</p>
        {next.length ? (
          next.map((appointment) => (
            <div className="line" key={appointment.id}>
              <span>{friendlyDateLong(appointment.scheduledDate)}</span>
              <span className="num" dir="ltr">{friendlyTime(appointment.scheduledTime)}</span>
            </div>
          ))
        ) : (
          // ولا يُترك الفراغ صامتًا: بياضٌ تحت العنوان يُقرأ «لم تُطبع» لا «لا موعد».
          <p style={{ fontSize: "9pt", fontWeight: 700, margin: "1mm 0" }}>
            لا موعد مسجَّل — اتصل بالمركز لحجز موعدك.
          </p>
        )}

        <div className="rule-light" />
        <p style={{ fontSize: "9pt", fontWeight: 700, margin: "1mm 0 0" }}>
          متابعة مواعيدك وحسابك من جوّالك: ادخل بوّابة المرضى برقم ملفّك أعلاه
          ورقم جوّالك المسجَّل لدينا.
        </p>

        {/* وتاريخ الطبع يقول إلى متى تصحّ الورقة. */}
        <p style={{ fontSize: "8pt", fontWeight: 700, marginTop: "3mm", opacity: 0.75 }}>
          طُبعت في {friendlyDateLong(today)} — والمواعيد قد تتغيّر، فراجع المركز عند الشكّ.
        </p>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
