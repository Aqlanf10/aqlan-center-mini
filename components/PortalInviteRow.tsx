"use client";

import { useEffect, useState } from "react";
import { useSetting } from "@/components/SettingsProvider";
import { portalInvite } from "@/lib/portalInvite";
import { toWhatsAppNumber } from "@/lib/reminders";

/**
 * صفُّ بوّابة المريض في ملفّه: عنوانُها، وزرٌّ يُرسلها إلى جواله.
 * (منقول من مستودع الوكيل الآخر لمكوّناتنا.)
 *
 * **ولماذا واتساب لا البطاقة المطبوعة؟** لأنّ الدخول إلى البوّابة عندنا
 * **رقمُ الجوال ورقمُ الملف**، وبطاقةُ المريض تحمل الاثنين معًا. فطبعُ العنوان
 * عليها يجعل بطاقةً تُنسى على طاولةٍ مفتاحًا كاملًا لحساب صاحبها. أمّا الإرسال
 * إلى جواله فيثبت ملكيّته للجوال نفسه الذي هو نصفُ المفتاح.
 *
 * **والعنوان يُقرأ من المتصفّح لا من إعداد.** فالبوّابة مسارٌ في هذا البرنامج
 * نفسه، فعنوانُها عنوانُه — وإعدادٌ يُكتب باليد يُنسى تحديثه عند نقل الاستضافة،
 * فيُرسل إلى المرضى رابطٌ ميّت لا يعرف أحدٌ أنّه مات.
 */
export function PortalInviteRow(
  { patientNumber, phone }: { patientNumber: string; phone: string | null },
) {
  const clinicName = useSetting("clinic.name");
  /*
   * والعنوان يُقرأ بعد التركيب لا أثناءه.
   *
   * فـ`window` لا وجود له في التصيير على الخادم، وقراءتُه مباشرةً تُسقط الصفحة
   * كلَّها — ملفُّ مريضٍ لا يُفتح لأجل صفٍّ فيه.
   */
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const invite = portalInvite({
    origin, clinicName: clinicName || "المركز", patientNumber,
  });
  if (!invite) return null;

  const whatsApp = toWhatsAppNumber(phone);

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2">
      <p className="text-[11px] font-extrabold text-slate-800">
        بوّابة المريض — يرى مواعيده وحسابه ويؤكّد حضوره
      </p>
      <p className="mt-0.5 text-[11px] font-bold text-slate-600" dir="ltr">{invite.url}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {/*
          * وبلا جوالٍ لا زرَّ إرسال — ولا يُفتح واتساب بلا رقم.
          *
          * فمن يضغط زرًّا معطَّلًا يظنّ العطبَ في البرنامج، ومن يُفتح له واتساب
          * بلا وجهةٍ يختار من قائمة جهاته — فيصل رقمُ ملف مريضٍ إلى غيره.
          */}
        {whatsApp ? (
          <a href={`https://wa.me/${whatsApp}?text=${encodeURIComponent(invite.text)}`}
            target="_blank" rel="noopener"
            className="rounded-lg bg-emerald-600 px-3 py-1 text-[11px] font-bold text-white hover:bg-emerald-700">
            أرسل البوّابة بواتساب
          </a>
        ) : (
          <span className="text-[11px] font-bold text-slate-500">
            لا جوال مسجَّل — أضِفه ليُرسل إليه الرابط
          </span>
        )}
        <button type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(invite.url).then(
              () => setCopied(true), () => setCopied(false));
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-50">
          {copied ? "نُسخ ✓" : "انسخ العنوان"}
        </button>
        <a href="/portal" target="_blank" rel="noopener"
          className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-50">
          افتحها لتراها
        </a>
      </div>
    </div>
  );
}
