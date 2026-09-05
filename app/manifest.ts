import type { MetadataRoute } from "next";
import { getSettingsSafe } from "@/lib/db";
import { ICONS_VERSION } from "@/lib/icons-version.generated";

/**
 * بيان التطبيق — قراءةً من الإعدادات لا ثابتًا.
 *
 * المرحلة ١٢ وحكمها: **نفس الـ API ونفس قاعدة البيانات بدون ازدواجية**. لا
 * تطبيقَ ثانٍ ولا مستودع ثانٍ: بيانُ التثبيت يجعل النظام نفسه يُثبَّت على سطح
 * المكتب (بلا شريط روابط — `standalone`) وعلى جوال الطاقم، وهو نفسه الويب
 * نفسه وقاعدته نفسها.
 *
 * والاسم من الإعدادات لأن تغيير اسم المركز من شاشة الإعدادات يجب أن يظهر
 * على أيقونة التطبيق المثبَّت عند أول تحديث لها، لا أن يبقى اسم بناءٍ قديم.
 *
 * ومسارات الأيقونات مُرقّمة ببصمة ملفّات الشعار (`ICONS_VERSION`): أيقونة
 * سطح المكتب وشريط المهام في ويندوز يولّدها المتصفح وقت التثبيت ويخزّنها
 * محليًا — فالمسار نفسه بمحتوى جديد يترك الاختصار على الأيقونة القديمة
 * مهما نُشر. وتبديل الاسم مع كل تغيير شعار يجبر المتصفح على تنزيل أيقونات
 * جديدة عند إعادة التثبيت. و`id` ثابت حتى تبقى إعادة التثبيت هي التطبيق
 * نفسه لدى المتصفح لا تطبيقًا ثالثًا موازيًا.
 */
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const settings = await getSettingsSafe();
  return {
    id: "/",
    name: settings["clinic.name"],
    short_name: settings["clinic.name"],
    description: "نظام تشغيل المركز — اليوم والمرضى والصندوق والمختبر والمخزون.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    dir: "rtl",
    lang: "ar",
    theme_color: "#0d2137",
    background_color: "#0d2137",
    icons: [
      { src: `/icons/icon-192.${ICONS_VERSION}.png`, sizes: "192x192", type: "image/png" },
      { src: `/icons/icon-512.${ICONS_VERSION}.png`, sizes: "512x512", type: "image/png" },
      {
        src: `/icons/maskable-512.${ICONS_VERSION}.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
