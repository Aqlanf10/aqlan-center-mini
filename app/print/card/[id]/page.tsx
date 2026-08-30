import { notFound } from "next/navigation";
import { getAppointment, getPatient, getSettingsSafe } from "@/lib/db";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { getAppointmentTypeLabel } from "@/lib/schedule";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * بطاقة موعد المريض — كرت مطبوع مقاس A6.
 *
 * يُسلَّم للمريض بعد حجز الموعد أو الزيارة الحالية ليحمله معه، متضمناً اليوم والساعة ونوع الإجراء
 * وتعليمات الحضور وأرقام التواصل مع المركز.
 */
export default async function AppointmentCardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [appointment, settings] = await Promise.all([
    getAppointment(id),
    getSettingsSafe(),
  ]);

  if (!appointment) notFound();

  const patient = await getPatient(appointment.patientId);

  const typeLabel = getAppointmentTypeLabel(appointment.appointmentType);

  return (
    <>
      <PrintButton docType="statement" docId={id} />
      <div className="sheet sheet-a6">
        <PrintHeader settings={settings} title="بطاقة موعد" compact />

        <div className="line">
          <span>المريض</span>
          <span style={{ fontWeight: 800 }}>{appointment.patientName}</span>
        </div>
        {patient && (
          <div className="line">
            <span>رقم الملف</span>
            <span className="num" dir="ltr">{patient.patientNumber}</span>
          </div>
        )}
        <div className="rule-light" />

        <div className="line line-strong" style={{ fontSize: "11pt", marginTop: "2mm" }}>
          <span>يوم وتاريخ الموعد</span>
          <span style={{ color: "#0d2137" }}>{friendlyDateLong(appointment.scheduledDate)}</span>
        </div>
        <div className="line line-strong" style={{ fontSize: "11pt" }}>
          <span>الوقت المحدد</span>
          <span style={{ color: "#c2410c" }}>{friendlyTime(appointment.scheduledTime)}</span>
        </div>

        {typeLabel && (
          <div className="line" style={{ marginTop: "1.5mm" }}>
            <span>نوع الإجراء الطبي</span>
            <span style={{ fontWeight: 700 }}>{typeLabel}</span>
          </div>
        )}

        <div className="line">
          <span>المدة التقديرية</span>
          <span>{appointment.durationMinutes} دقيقة</span>
        </div>

        {appointment.note && (
          <div className="line" style={{ fontSize: "8pt", color: "#475569" }}>
            <span>ملاحظات</span>
            <span>{appointment.note}</span>
          </div>
        )}

        <div className="rule" />

        <div style={{ fontSize: "7.5pt", color: "#334155", lineHeight: "1.6", marginTop: "2mm" }}>
          <p style={{ fontWeight: 700, marginBottom: "1mm" }}>📌 إرشادات وتعليمات الموعد:</p>
          <ul style={{ paddingRight: "4mm", margin: 0 }}>
            <li>يرجى التكرم بالحضور قبل الموعد بـ 10 دقائق لتأكيد الدخول.</li>
            <li>في حال الرغبة بتأجيل أو إلغاء الموعد يرجى إبلاغنا مسبقاً بوقت كافٍ.</li>
            <li>يرجى إحضار بطاقة الموعد والملفات السابقة عند الزيارة.</li>
          </ul>
        </div>

        <div className="sign-row" style={{ marginTop: "5mm" }}>
          <span>قسم المواعيد والاستقبال</span>
          <span>الختم: ................</span>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
