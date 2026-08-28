import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { getSettingsSafe } from "@/lib/db";
import { publicSubset } from "@/lib/settings";
import { SettingsProvider } from "@/components/SettingsProvider";
import { SessionProvider } from "@/components/SessionProvider";
import { requireSession } from "@/lib/session";
import { AppShell } from "@/components/AppShell";

/**
 * خط الواجهة — مُستضاف معنا لا مطلوب من خادم بعيد.
 *
 * الخط الافتراضي للنظام يعني أن البرنامج يبدو مختلفًا على كل جهاز: خطٌّ على ويندوز
 * وآخر على أندرويد وثالث على iPad، وأوزانٌ لا تتطابق. وهوية لا تثبت عبر الأجهزة
 * ليست هوية.
 *
 * و`display: swap` مقصود: النصّ يظهر فورًا بخط النظام ثم يُستبدل — فشاشة الاستقبال
 * لا تبقى بيضاء ثانيةً كاملة في وقت الزحمة.
 */
const arabic = localFont({
  src: [
    { path: "./fonts/plex-arabic-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-arabic-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plex-arabic-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/plex-arabic-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-arabic",
  display: "swap",
});

export const metadata: Metadata = {
  title: "عيادة عقلان — نظام إدارة المركز",
  description: "تشغيل يومي: الانتظار والمواعيد والمرضى والمختبر والمالية.",
  // أيقونة التبويب: شاشة الاستقبال تفتح خمسة تبويبات، وتبويبٌ بلا أيقونة يضيع
  // بينها. وهي هنا بقرصٍ كحلي خلفها لأن تبويب المتصفّح خلفيته بيضاء أو رمادية.
  icons: { icon: "/icon.svg" },
};

// اللوحة تُفتح على شاشة الاستقبال وعلى الهاتف معًا، فالتكبير يبقى متاحًا عمدًا:
// منعه يجعل الأرقام الصغيرة غير مقروءة لمن يحتاج تكبيرها.
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/**
 * التخطيط الجذري يقرأ الإعدادات مرة لكل طلب ويمرّرها إلى الشجرة كلها.
 *
 * وهو `dynamic` لهذا السبب: صفحاتٌ ساكنة كانت ستُخبز باسم المركز القديم وقت البناء
 * ولا تتغيّر حتى النشرة التالية — وهذا بالضبط ما تُلغيه شاشة الإعدادات.
 */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [settings, session] = await Promise.all([
    getSettingsSafe(),
    // الجلسة قد تكون غائبة — صفحة الدخول والشاشات العامة تُصيَّر بلا واحدة.
    requireSession().catch(() => null),
  ]);

  return (
    <html lang="ar" dir="rtl" className={arabic.variable}>
      <body className="min-h-full bg-canvas font-sans text-navy-900 antialiased">
        <SettingsProvider value={publicSubset(settings)}>
          <SessionProvider value={session ? { username: session.username, role: session.role } : null}>
            <AppShell>{children}</AppShell>
          </SessionProvider>
        </SettingsProvider>
      </body>
    </html>
  );
}
