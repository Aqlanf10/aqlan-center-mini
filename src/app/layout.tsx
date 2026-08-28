import type { Metadata } from "next";
import { Tajawal } from "next/font/google";
import { Toaster } from "sonner";
import { getDirection, LOCALE_HTML_LANGS } from "@/i18n/config";
import { getI18n } from "@/i18n/server";
import { I18nProvider } from "@/i18n/provider";
import "./globals.css";

// Brand font — same typeface family as the main aqlan-dental system.
const tajawal = Tajawal({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "700", "800"],
  variable: "--font-tajawal",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const { dict } = await getI18n();
  return {
    title: {
      default: dict.app.name,
      template: `%s | ${dict.app.name}`,
    },
    description: `${dict.app.tagline} — ${dict.app.centerName}`,
    applicationName: dict.app.name,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { locale, dict } = await getI18n();

  return (
    <html lang={LOCALE_HTML_LANGS[locale]} dir={getDirection(locale)}>
      <body className={`${tajawal.variable} font-sans antialiased`}>
        <I18nProvider locale={locale} dict={dict}>
          {children}
          <Toaster richColors position="top-center" />
        </I18nProvider>
      </body>
    </html>
  );
}
