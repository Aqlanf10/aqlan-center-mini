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
export function InstallApp() {
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
      <p className="rounded-xl border border-success-200 bg-success-50 p-3 text-sm font-bold text-success-800">
        ثُبِّت النظام. ستجده في قائمة البرامج وسطحه، وبلا شريط روابط.
      </p>
    );
  }

  if (!available) return null;

  return (
    <button onClick={install}
      className="rounded-xl bg-navy-800 px-4 py-2 text-sm font-bold text-white hover:bg-navy-700">
      ثبّت النظام كتطبيق
    </button>
  );
}
