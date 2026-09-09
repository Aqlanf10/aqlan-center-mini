import type { NextConfig } from "next";
import { HSTS_HEADER, STATIC_SECURITY_HEADERS } from "./lib/csp";

/**
 * ترويسات الأمن الثابتة على كل المسارات (P2/S2) — من المصدر الواحد
 * lib/csp.ts الذي تقرأه اختبارات الانحدار أيضًا (S17): تختفي الترويسة
 * من هنا = يفشل CI، لا أن تمر صامتة.
 *
 * CSP بـnonce **ليست هنا**: الترويسات الثابتة لا تستطيع توليد nonce لكل
 * طلب — مسؤولية proxy.ts (S3)، وهذه هي بقية الطبقة الثابتة.
 */
const staticHeaders: Array<{ key: string; value: string }> = STATIC_SECURITY_HEADERS.map(
  (header) => ({ key: header.key, value: header.value }),
);

// HSTS في الإنتاج فقط: الترويسة تُقيّم عند تحميل الإعداد وقت التشغيل،
// وstandalone server يعمل بproduction فتظهر — والتطوير المحلي بHTTP
// لا يظهرها (ترويسة HTTPS على اتصال HTTP يربك أدوات التطوير بلا فائدة).
// القيمة محافظة عمدًا: بلا preload وبلا includeSubDomains — الأولى قرار
// لا رجعة فيه على مستوى النطاق، والثانية تنتظر إثبات ملكية كل النطاقات
// الفرعية — ولا واحد منهما متحقق اليوم.
const isProduction = process.env.NODE_ENV === "production";
if (isProduction) {
  staticHeaders.push({ key: HSTS_HEADER.key, value: HSTS_HEADER.value });
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * حزم خارجية على الخادم: محرّك PGlite المدمج يحمّل ملف WASM من node_modules
   * وقت التشغيل بمسار محسوب من موضع الحزمة نفسها. حين يُحزم داخل بناء Next.js
   * يتحول المسار إلى كائن URL فيسقط تحميل المحرك بخطأ مسارٍ في الإنتاج وحده —
   * التطوير يعمل والنشر يتعطل، وهو أخطر نوعٍ من الأخطاء. إعلانها خارجية يجعل
   * البناء يستدعيها من node_modules كما هي فيعمل المحرك في الحالتين.
   */
  serverExternalPackages: ["@electric-sql/pglite"],
  /**
   * بناء مستقل: يُخرج `server.js` ومعه أدنى ما يلزم من الاعتماديات فقط.
   *
   * بلا هذا تحتاج صورة النشر `node_modules` كاملة — مئات الميغابايتات وآلاف الملفات
   * التي لا يقرأها التشغيل أصلًا، فيبطؤ كل نشر وتتّسع مساحة الهجوم بلا مقابل.
   */
  output: "standalone",

  /**
   * (P2/S2) لا نعلن تقنية الخادم في كل رد — X-Powered-By: Next.js
   * بصمة مجانية لفاحص الإصدارات. إزالتها هنا تُثبت باختبار HTTP (S14).
   */
  poweredByHeader: false,

  /**
   * (P2/S8) سقف جسم الطلب في طبقة الـproxy — تجريبي (experimental) بحسب
   * توثيق Next نفسه، **ليس الحارس الوحيد ولا الأول**: القارئ المحدود
   * (lib/http-body.ts) وسقف Content-Length المعلن في proxy.ts هما الحكم،
   * وهذا طبقة إضافية فحسب. القيمة فوق سقف رفع المستندات (25MB) بلا
   * تضخيم يبطل غايته.
   */
  experimental: {
    proxyClientMaxBodySize: 32 * 1024 * 1024,
  },

  async headers() {
    return [
      {
        // كل المسارات بما فيها الأصول الساكنة — nosniff والاحتواء لا يضران
        // ملفًّا ثابتًا، والحماية هنا أوسع لا أضيق.
        source: "/(.*)",
        headers: staticHeaders,
      },
    ];
  },
};

export default nextConfig;
