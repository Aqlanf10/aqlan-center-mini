import type { MetadataRoute } from "next";

/**
 * (INSTALL-1) بيان تطبيق «شاشة الصالة» — تطبيقٌ ثانٍ مستقل يُثبَّت على التلفاز أو جهازه.
 *
 * تطبيق الطاقم (`app/manifest.webmanifest/route.ts`) يبدأ من «/» — أي شاشة الدخول. والتلفاز لا يسجّل الدخول
 * ولا يُراد له أن يُظهر رابطًا: فهذا البيان يبدأ من `/display` مباشرةً، ونطاقه `/display`
 * وحدها، وبملء الشاشة أفقيًّا بلا شريط روابط ولا أزرار متصفح. و`id` مختلف عن تطبيق
 * الطاقم فيُثبَّتان جنبًا إلى جنب على الجهاز نفسه بأيقونتين.
 */
export function displayAppManifest(clinicName: string, iconsVersion: string): MetadataRoute.Manifest {
  const name = clinicName.trim() || "المركز";
  return {
    id: "/display",
    name: `${name} — شاشة الصالة`,
    short_name: "شاشة الصالة",
    description: "شاشة النداء في صالة الانتظار — تُفتح بملء الشاشة بلا رابط.",
    start_url: "/display",
    scope: "/display",
    display: "fullscreen",
    display_override: ["fullscreen", "standalone"],
    orientation: "landscape",
    dir: "rtl",
    lang: "ar",
    theme_color: "#0d2137",
    background_color: "#0d2137",
    icons: [
      { src: `/icons/icon-192.${iconsVersion}.png`, sizes: "192x192", type: "image/png" },
      { src: `/icons/icon-512.${iconsVersion}.png`, sizes: "512x512", type: "image/png" },
      { src: `/icons/maskable-512.${iconsVersion}.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
