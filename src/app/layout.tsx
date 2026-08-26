import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-arabic",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Aqlan Center Mini",
    template: "%s | Aqlan Center Mini",
  },
  description:
    "Lightweight clinic operations system for Aqlan Center for Orthodontics, Implants and Cosmetic Dentistry.",
  applicationName: "Aqlan Center Mini",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body className={`${inter.variable} ${plexArabic.variable}`}>
        {children}
      </body>
    </html>
  );
}
