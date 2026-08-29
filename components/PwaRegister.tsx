"use client";

import { useEffect } from "react";

/**
 * تسجيل عامل الخدمة والتقاط دعوة التثبيت.
 *
 * يُتركَب مرة واحدة في التخطيط الجذري. دعوة التثبيت (`beforeinstallprompt`)
 * تُطلق قبل أن تفتح شاشة الإعدادات أحيانًا، فتُعلَّق هنا على النافذة ليلتقطها
 * زر التثبيت حين يُفتح — والبديل إغلاقٌ ضائع لا يُعاد إلا بإعادة التشغيل.
 *
 * المهم أن ما يُثبَّت هو النظام نفسه: نفس الصفحات ونفس API ونفس القاعدة —
 * لا حزمة ثانية تُبنى وتُصان.
 */
declare global {
  interface Window {
    __aqlanInstallPrompt?: Event | null;
  }
}

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // تسجيلٌ فاشل يُبقي النظام كاملًا: ما يضيع هو التثبيت وحده.
      });
    };
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      window.__aqlanInstallPrompt = event;
    });
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

/** المعلّق يُستهلَم في مكانه: الزر في الإعدادات يقرأه ويتخلص منه بعد الاستخدام. */
export function consumeInstallPrompt(): boolean {
  return typeof window !== "undefined" && Boolean(window.__aqlanInstallPrompt);
}
