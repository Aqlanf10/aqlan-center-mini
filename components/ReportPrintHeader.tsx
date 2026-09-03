"use client";

import { Logo } from "./Icon";
import { useSetting } from "./SettingsProvider";

/**
 * ترويسة هوية المركز للتقارير المطبوعة — الشعار والاسم من الإعدادات لا من الكود.
 *
 * كل تقرير يخرج من المركز ورقةٌ تحمل اسمه: اسمٌ خاطئ على تقريرٍ يدقّه المحاسب
 * أو يُرسل لمختبر يوقع أن المركز «غيره». والهوية كلها (شعار، اسم، طبيب، لقب،
 * هاتف، عنوان) قيمٌ من جدول الإعدادات — لا تنسخ في ملف تقرير، لأن النسخة
 * تشيخ يوم يغيّر المالك هاتفه ولا يمرّ على عشر نوافذ تقارير.
 *
 * نسختان:
 * - `ReportPrintHeader`: ترويسة كاملة أعلى الورقة — الشعار ثم الاسم ثم الطبيب
 *   ثم التواصل ثم خطٌّ وعنوان المستند. للطباعة المركزية (مركز التقارير، تقرير اليوم).
 * - `ReportPrintIdentity`: كتلة الهوية وحدها (شعار + اسم + طبيب + تواصل) لتُدمج
 *   في ترويسة تقريرٍ له امتداداته الخاصة — مرجع تدقيق أو رمز QR مثلًا.
 *
 * والخواص الاختيارية تغلب الإعدادات عند ورودها، فالنافذة التي لديها القيم
 * من سياقها تستعملها، والتي لا تملك تسأل الإعدادات مباشرةً.
 */

export function ReportPrintIdentity({
  clinicName,
  clinicPhone,
  clinicAddress,
  showContacts = true,
  center = false,
  logoClassName = "h-14 w-14",
}: {
  clinicName?: string;
  clinicPhone?: string;
  clinicAddress?: string;
  showContacts?: boolean;
  center?: boolean;
  logoClassName?: string;
}) {
  const sName = useSetting("clinic.name");
  const sDoctor = useSetting("clinic.lead_doctor");
  const sDoctorTitle = useSetting("clinic.lead_doctor_title");
  const sPhone = useSetting("clinic.phone");
  const sAddress = useSetting("clinic.address");

  const name = clinicName ?? sName;
  const phone = clinicPhone ?? sPhone;
  const address = clinicAddress ?? sAddress;

  return (
    <div className={`flex items-center gap-3 ${center ? "flex-col text-center" : ""}`} dir="rtl">
      {/* الشعار أول السطر: مستندٌ باسم المركز يُعرف من بعيد بين أوراق كثيرة.
          ويُعرض متجهيًا (PNG شفاف) فيخرج حادًّا على أي طابعة. */}
      <Logo className={`${logoClassName} shrink-0`} />
      <div className="min-w-0">
        <p className="text-base font-black leading-snug text-navy-950">{name}</p>
        <p className="mt-0.5 text-[11px] font-semibold text-slate-600">
          {sDoctor} — {sDoctorTitle}
        </p>
        {showContacts && (phone || address) ? (
          <p className="mt-0.5 text-[10px] text-slate-500">
            {address ? <span>{address}</span> : null}
            {address && phone ? <span> · </span> : null}
            {phone ? (
              <>
                هاتف: <span dir="ltr">{phone}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ReportPrintHeader({
  title,
  subtitle,
  clinicName,
  clinicPhone,
  clinicAddress,
  docMeta,
}: {
  title: string;
  subtitle?: string;
  clinicName?: string;
  clinicPhone?: string;
  clinicAddress?: string;
  docMeta?: string;
}) {
  return (
    <div dir="rtl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ReportPrintIdentity
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          clinicAddress={clinicAddress}
        />
        {docMeta ? (
          <p className="shrink-0 text-[10px] font-semibold text-slate-500">{docMeta}</p>
        ) : null}
      </div>
      <div className="border-b-2 border-navy-900 pb-2 text-center">
        <p className="text-sm font-bold text-navy-950">{title}</p>
        {subtitle ? <p className="mt-0.5 text-[11px] text-slate-600">{subtitle}</p> : null}
      </div>
    </div>
  );
}
