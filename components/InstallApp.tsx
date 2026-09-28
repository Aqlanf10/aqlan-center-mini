"use client";

import { useEffect, useState } from "react";

/**
 * زر «ثبّت النظام كتطبيق» — المرحلة ١٢ من جهة صاحب المركز.
 *
 * سطح المكتب بلا شريط روابط، وجوال الطاقم بأيقونة على الشاشة الرئيسية — وهو
 * النظام نفسه: نفس الصفحات ونفس API ونفس القاعدة، بلا مستودع ثانٍ يُبنى ويُصان.
 *
 * المتصفحات تُعلق دعوة التثبيت في `beforeinstallprompt` وتُطلقها مرة؛ التسجيل
 * في `PwaRegister` يحتفظ بها على النافذة لأن هذه الشاشة قد تُفتح بعد أوانها.
 * سؤال «مثبَّت أصلًا؟» سؤال عارض — بلا واجهة معيارية موثوقة تُحكمه، فلا يُدَّعى.
 */
/**
 * (INSTALL-1) الزر نفسه في ثلاثة أماكن: الإعدادات، وشاشة الدخول (أول ما يراه جهاز جديد)، وشاشة
 * الصالة على التلفاز (فيُثبَّت تطبيقها هي — بيانها يبدأ من /display بملء الشاشة). `tone="dark"`
 * للخلفية الداكنة في شاشة الصالة. ولا يظهر إلا حين يعرض المتصفح التثبيت فعلًا، ولا داخل تطبيقٍ مثبَّت.
 */
export function InstallApp({ label = "ثبّت النظام كتطبيق", tone = "light", installedText }: {
  label?: string;
  tone?: "light" | "dark";
  installedText?: string;
} = {}) {
  const [available, setAvailable] = useState(false);
  const [installedNow, setInstalledNow] = useState(false);

  useEffect(() => {
    const detect = () => setAvailable(Boolean(window.__aqlanInstallPrompt));
    detect();
    // قد تصل الدعوة متأخرة عن أول رسم.
    const timer = window.setTimeout(detect, 1500);
    const onInstalled = () => {
      setAvailable(false);
      setInstalledNow(true);
    };
    window.addEventListener("beforeinstallprompt", detect);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", detect);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    const event = window.__aqlanInstallPrompt;
    if (!event) return;
    event.preventDefault();
    const prompt = event as Event & { prompt: () => Promise<void> };
    await prompt.prompt();
    window.__aqlanInstallPrompt = null;
    setAvailable(false);
  };

  if (installedNow) {
    return (
      <p className={tone === "dark"
        ? "rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white"
        : "rounded-xl border border-success-200 bg-success-50 p-3 text-sm font-bold text-success-800"}>
        {installedText ?? "ثُبِّت النظام. ستجده في قائمة البرامج وسطحه، وبلا شريط روابط."}
      </p>
    );
  }

  if (!available) return null;

  return (
    <button type="button" onClick={install}
      className={tone === "dark"
        ? "rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white hover:bg-white/20"
        : "rounded-xl bg-navy-800 px-4 py-2 text-sm font-bold text-white hover:bg-navy-700"}>
      📲 {label}
    </button>
  );
}
