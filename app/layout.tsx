import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import "./globals.css";
import { CLINIC_TIME_ZONE, findUserByUsername, getSettingsSafe } from "@/lib/db";
import { publicSubset } from "@/lib/settings";
import { SettingsProvider } from "@/components/SettingsProvider";
import { SessionProvider } from "@/components/SessionProvider";
import { requireSession } from "@/lib/session";
import { admitCanonicalStaffSession, selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { AppShell } from "@/components/AppShell";
import { PwaRegister } from "@/components/PwaRegister";

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

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettingsSafe();
  return {
  title: `${settings["clinic.name"]} — نظام إدارة المركز`,
  description: "تشغيل يومي: الانتظار والمواعيد والمرضى والمختبر والمالية.",
  manifest: "/manifest.webmanifest",
  // أيقونة التبويب من شعار المالك الحقيقي: app/favicon.ico (١٦/٣٢/٤٨/٦٤) و
  // app/icon.png وapp/apple-icon.png — Next يولّد روابطها من الملفات نفسها،
  // فلا مسار يدوي يتقادم عند تغيير الشعار. (scripts/gen-pwa-icons.mjs)
  };
}

// اللوحة تُفتح على شاشة الاستقبال وعلى الهاتف معًا، فالتكبير يبقى متاحًا عمدًا:
// منعه يجعل الأرقام الصغيرة غير مقروءة لمن يحتاج تكبيرها.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0d2137",
};

/**
 * التخطيط الجذري يقرأ الإعدادات مرة لكل طلب ويمرّرها إلى الشجرة كلها.
 *
 * وهو `dynamic` لهذا السبب: صفحاتٌ ساكنة كانت ستُخبز باسم المركز القديم وقت البناء
 * ولا تتغيّر حتى النشرة التالية — وهذا بالضبط ما تُلغيه شاشة الإعدادات.
 */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const publicDisplay = (await headers()).get("x-aqlan-public-display") === "1";
  /* قاعدة اختيار واحدة: كوكي موحّدة تُقبل بإثبات القاعدة الحالي ولا تمر أبدًا بالمسار
     القديم؛ غيرها يبقى على requireSession كما كان. */
  const selected = publicDisplay ? { kind: "none" as const } : await selectRequestStaffEnvelope().catch(() => ({ kind: "none" as const }));
  const canonical = selected.kind === "canonical" || selected.kind === "denied";
  const [settings, session, canonicalView] = await Promise.all([
    getSettingsSafe(),
    // الجلسة قد تكون غائبة — صفحة الدخول والشاشات العامة تُصيَّر بلا واحدة.
    publicDisplay || canonical ? Promise.resolve(null) : requireSession().catch(() => null),
    selected.kind === "canonical" ? admitCanonicalStaffSession(selected.handle).catch(() => null) : Promise.resolve(null),
  ]);

  let user = null;
  if (session) {
    user = await findUserByUsername(session.username).catch(() => null);
  }
  const sessionValue = canonicalView
    ? {
        username: canonicalView.username,
        role: canonicalView.roleLabel,
        displayName: canonicalView.displayName,
        permissions: null,
        canonical: true,
        isOwner: canonicalView.isOwner,
        capabilities: [...canonicalView.capabilities],
        patientScope: canonicalView.patientScope,
        appointmentScope: canonicalView.appointmentScope,
      }
    : session
      ? {
          username: session.username,
          role: session.role,
          displayName: user?.displayName || session.username,
          permissions: user?.permissions || null,
        }
      : null;

  return (
    <html lang="ar" dir="rtl" className={arabic.variable}>
      <body className="min-h-full bg-canvas font-sans text-navy-900 antialiased">
        <SettingsProvider value={publicDisplay ? { "clinic.name": settings["clinic.name"] } : publicSubset(settings)}>
          {publicDisplay ? children : <SessionProvider
            value={sessionValue}
          >
            <AppShell clinicTimeZone={CLINIC_TIME_ZONE}>{children}</AppShell>
          </SessionProvider>}
        </SettingsProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
