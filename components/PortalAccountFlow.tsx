"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  KeyRound,
  Lock,
  LogIn,
  MapPin,
  Megaphone,
  Phone,
  ShieldCheck,
  Sparkles,
  Type,
  User,
  WifiOff,
} from "lucide-react";
import { Logo } from "@/components/Icon";
import { LoginPhoto } from "@/components/LoginPhoto";

export type PortalLang = "ar" | "en";

export interface PortalAdminPreviewInfo {
  staffUserId: number;
  staffUsername: string;
  staffDisplayName: string;
  staffRole: string;
  staffCredentialVersion?: number;
  reason: string;
  startedAt: number;
  expiresAt: number;
}

export interface PortalVisibleSectionsView {
  profile: boolean;
  appointments: boolean;
  allowAppointmentConfirm: boolean;
  showBookingLink: boolean;
  visits: boolean;
  treatmentPlans: boolean;
  statement: boolean;
  prescriptions: boolean;
  documents: boolean;
  xrayDocuments: boolean;
  intake: boolean;
  messages: boolean;
  allowMessageAttachments: boolean;
  allowVoiceMessages: boolean;
  announcements: boolean;
}

export interface PortalProfileSummaryView {
  patientNumber: string;
  fullName: string;
  maskedPhone: string | null;
  genderLabel: string | null;
  birthYear: number | null;
  city: string | null;
  primaryDoctorName: string | null;
  portalLoginName: string | null;
  lastLoginAt: string | null;
  passwordUpdatedAt: string | null;
}

export interface PortalSessionInfo {
  fullName: string;
  patientNumber: string;
  loginName?: string;
  operatingMode?: "disabled" | "sandbox_test" | "live_enabled";
  visibleSections?: PortalVisibleSectionsView;
  profile?: PortalProfileSummaryView | null;
  adminPreview?: PortalAdminPreviewInfo;
}

interface PublicAnnouncementView {
  id: number;
  titleAr: string;
  bodyAr: string;
  titleEn: string | null;
  bodyEn: string | null;
  badgeLabel: string | null;
  tone: "sky" | "navy" | "accent" | "emerald" | "amber";
  isSample: boolean;
}

interface PortalPublicBootstrapView {
  clinic: {
    name: string;
    englishName: string;
    leadDoctor: string;
    leadDoctorTitle: string;
    phone: string;
    address: string;
    hours: string;
    loginPhotoVisible: boolean;
  };
  operatingMode: "disabled" | "sandbox_test" | "live_enabled";
  showBookingLink: boolean;
  showAnnouncements: boolean;
  announcements: PublicAnnouncementView[];
}

const DEFAULT_BOOTSTRAP: PortalPublicBootstrapView = {
  clinic: {
    name: "مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان",
    englishName: "Dr. Aqlan Dental Center",
    leadDoctor: "د. عقلان الكامل",
    leadDoctorTitle: "استشاري تقويم وزراعة وتجميل الأسنان",
    phone: "",
    address: "صنعاء",
    hours: "السبت – الخميس · 9 صباحًا – 9 مساءً",
    loginPhotoVisible: false,
  },
  operatingMode: "disabled",
  showBookingLink: true,
  showAnnouncements: true,
  announcements: [],
};

const TONE_CLASSES: Record<
  PublicAnnouncementView["tone"],
  { border: string; badge: string; dot: string }
> = {
  sky: {
    border: "border-sky-400/35 bg-sky-500/10",
    badge: "bg-sky-400/20 text-sky-100 border-sky-300/35",
    dot: "bg-sky-300",
  },
  navy: {
    border: "border-white/15 bg-white/8",
    badge: "bg-white/15 text-slate-100 border-white/25",
    dot: "bg-slate-200",
  },
  accent: {
    border: "border-brand-orange/35 bg-brand-orange/12",
    badge: "bg-brand-orange/25 text-amber-100 border-brand-orange/40",
    dot: "bg-brand-orange",
  },
  emerald: {
    border: "border-emerald-400/35 bg-emerald-500/10",
    badge: "bg-emerald-400/20 text-emerald-100 border-emerald-300/35",
    dot: "bg-emerald-300",
  },
  amber: {
    border: "border-amber-400/35 bg-amber-500/10",
    badge: "bg-amber-400/20 text-amber-100 border-amber-300/35",
    dot: "bg-amber-300",
  },
};

export function PortalAdminPreviewBanner({
  preview,
  lang = "ar",
  onExited,
}: {
  preview: PortalAdminPreviewInfo;
  lang?: PortalLang;
  onExited: (returnTo: string) => void;
}) {
  const [exiting, setExiting] = useState(false);

  const handleExit = async () => {
    setExiting(true);
    try {
      const response = await fetch("/api/portal/admin-preview/exit", { method: "POST" });
      const payload = await response.json().catch(() => null);
      onExited(typeof payload?.returnTo === "string" ? payload.returnTo : "/");
    } catch {
      onExited("/");
    } finally {
      setExiting(false);
    }
  };

  const expiresTime = new Date(preview.expiresAt).toLocaleTimeString(
    lang === "ar" ? "ar-YE" : "en-US",
    { hour: "2-digit", minute: "2-digit" },
  );

  return (
    <section
      role="region"
      aria-label="تنبيه الدخول الإداري لبوابة المريض"
      data-testid="portal-admin-preview-banner"
      className="mb-4 rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-black uppercase tracking-wide text-amber-800">
            {lang === "ar"
              ? "وضع الدخول الإداري المقيّد — للقراءة فقط"
              : "Administrative Read-Only Preview Mode"}
          </p>
          <p className="text-sm font-bold">
            {lang === "ar" ? "أنت تتصفح بوابة المريض بصفتك الوظيفية: " : "Viewing as staff: "}
            <span className="font-black">{preview.staffDisplayName}</span> ({preview.staffUsername})
          </p>
          <p className="text-xs text-amber-900">
            {lang === "ar" ? "السبب المسجّل في التدقيق: " : "Audited reason: "}
            <span className="font-semibold">{preview.reason}</span>
            {" · "}
            {lang === "ar"
              ? `تنتهي الجلسة الساعة ${expiresTime} · لا يُسمح بتنفيذ أي إجراء باسم المريض.`
              : `Expires at ${expiresTime} · Zero actions may be performed on behalf of the patient.`}
          </p>
        </div>
        <button
          type="button"
          onClick={handleExit}
          disabled={exiting}
          data-testid="portal-admin-preview-exit"
          className="rounded-xl bg-amber-900 px-3.5 py-2 text-xs font-black text-white hover:bg-amber-950 disabled:opacity-50"
        >
          {exiting
            ? lang === "ar"
              ? "جارٍ الخروج…"
              : "Exiting…"
            : lang === "ar"
              ? "خروج من عرض البوابة الإداري"
              : "Exit Admin Preview"}
        </button>
      </div>
    </section>
  );
}

export function PortalLoginAndTokenScreen({
  onLogin,
  lang = "ar",
  onToggleLang,
  largeText = false,
  onToggleLargeText,
}: {
  onLogin: (session: PortalSessionInfo) => void;
  lang?: PortalLang;
  onToggleLang?: () => void;
  largeText?: boolean;
  onToggleLargeText?: () => void;
}) {
  const isAr = lang === "ar";
  const [bootstrap, setBootstrap] = useState<PortalPublicBootstrapView>(DEFAULT_BOOTSTRAP);
  const [flowMode, setFlowMode] = useState<"login" | "activate" | "reset">("login");
  const [rawToken, setRawToken] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{
    loginName: string;
    patientFirstName: string;
    expiresAt: string;
  } | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [showForgotHelp, setShowForgotHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const updateOnline = () => {
      setIsOffline(typeof navigator !== "undefined" ? !navigator.onLine : false);
    };
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    void fetch("/api/portal/bootstrap", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as PortalPublicBootstrapView;
        if (data?.clinic?.name) setBootstrap(data);
      })
      .catch(() => {});

    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get("mode");
    const tokenParam = params.get("token");
    if ((modeParam === "activate" || modeParam === "reset") && tokenParam) {
      setFlowMode(modeParam);
      setRawToken(tokenParam);
      // إزالة الرمز السري من شريط العنوان فور التقاطه لمنع بقائه في سجل المتصفح أو Referer.
      const cleanParams = new URLSearchParams(window.location.search);
      cleanParams.delete("token");
      cleanParams.delete("mode");
      const nextQuery = cleanParams.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`,
      );

      setTokenLoading(true);
      setError(null);
      void fetch("/api/portal/token-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenParam }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(data?.message ?? "انتهت صلاحية الرابط أو سبق استخدامه.");
          }
          setTokenInfo({
            loginName: data.loginName,
            patientFirstName: data.patientFirstName,
            expiresAt: data.expiresAt,
          });
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "تعذّر التحقق من الرابط.");
        })
        .finally(() => {
          setTokenLoading(false);
        });
    }
  }, []);

  const handleKeyEvent = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState === "function") {
      setCapsLockOn(event.getModifierState("CapsLock"));
    }
  };

  const submitLogin = async () => {
    if (!username.trim()) {
      setError(isAr ? "يرجى إدخال اسم المستخدم." : "Please enter your username.");
      return;
    }
    if (!password) {
      setError(isAr ? "يرجى إدخال كلمة المرور." : "Please enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.message ??
            (isAr ? "تعذّر تسجيل الدخول." : "Unable to sign in right now."),
        );
      }
      onLogin(payload as PortalSessionInfo);
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : isAr
            ? "تعذّر تسجيل الدخول."
            : "Unable to sign in.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitTokenPassword = async () => {
    if (password.length < 10) {
      setError(
        isAr
          ? "يجب أن تتكون كلمة المرور من 10 أحرف على الأقل وتجمع بين حروف وأرقام."
          : "Password must be at least 10 characters and include letters and numbers.",
      );
      return;
    }
    if (password !== confirmPassword) {
      setError(isAr ? "كلمتا المرور غير متطابقتين." : "Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const endpoint =
        flowMode === "activate" ? "/api/portal/activate" : "/api/portal/reset-password";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.message ??
            (isAr ? "تعذّر حفظ كلمة المرور." : "Unable to save your password."),
        );
      }
      onLogin(payload as PortalSessionInfo);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isAr
            ? "تعذّر حفظ كلمة المرور."
            : "Unable to save password.",
      );
    } finally {
      setBusy(false);
    }
  };

  const passHasMinLen = password.length >= 10;
  const passHasLetterAndDigit = /[A-Za-z\u0600-\u06FF]/.test(password) && /\d/.test(password);

  return (
    <main
      dir={isAr ? "rtl" : "ltr"}
      className={`min-h-screen bg-gradient-to-br from-slate-50 via-sky-50/50 to-slate-100 px-3 py-4 sm:px-6 sm:py-8 ${
        largeText ? "text-[17px]" : ""
      }`}
    >
      <div className="mx-auto max-w-6xl">
        {/* شريط الأدوات العلوي: اللغة وتكبير الخط لسهولة القراءة */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-bold text-navy-800">
            <ShieldCheck className="h-4 w-4 text-sky-600" aria-hidden="true" />
            <span>
              {isAr
                ? "بوابة المريض الرسمية — اتصال مشفّر ومحمّي"
                : "Official Patient Portal — Protected & Encrypted"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {onToggleLargeText && (
              <button
                type="button"
                onClick={onToggleLargeText}
                data-testid="portal-font-size-toggle"
                aria-pressed={largeText}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition ${
                  largeText
                    ? "border-sky-500 bg-sky-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-sky-300"
                }`}
              >
                <Type className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAr ? "خط كبير A+" : "Large Text A+"}</span>
              </button>
            )}
            {onToggleLang && (
              <button
                type="button"
                onClick={onToggleLang}
                data-testid="portal-lang-toggle"
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 hover:border-sky-300"
              >
                <Globe className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
                <span>{isAr ? "English" : "العربية"}</span>
              </button>
            )}
          </div>
        </div>

        {/* الحاوية الرئيسية ذات اللوحين: نموذج الدخول أولًا على الجوال لسرعة الوصول */}
        <div className="grid overflow-hidden rounded-3xl border border-slate-200/90 bg-white shadow-xl lg:grid-cols-12">
          {/* اللوحة الهوياتية وإعلانات المركز (يمين في سطح المكتب، وأسفل النموذج في الجوال لعدم إعاقة الدخول السريع) */}
          <section
            aria-label={isAr ? "هوية المركز وإعلاناته" : "Center Identity & Announcements"}
            className="relative order-2 flex flex-col justify-between overflow-hidden bg-gradient-to-br from-navy-900 via-navy-800 to-[#0c3559] p-6 text-white sm:p-8 lg:order-1 lg:col-span-6 lg:p-10"
          >
            {/* توهجات الهوية: السماوي الهادئ مع البرتقالي والكحلي */}
            <div
              className="pointer-events-none absolute -top-24 -right-20 h-72 w-72 rounded-full bg-sky-400 opacity-20 blur-3xl"
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute -bottom-24 -left-20 h-72 w-72 rounded-full bg-brand-orange opacity-20 blur-3xl"
              aria-hidden="true"
            />

            <div className="relative z-10 space-y-6">
              {/* الشعار الرسمي ووسام البوابة */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/10 px-3.5 py-2 backdrop-blur-md">
                  <Logo variant="white" className="h-11 w-11 shrink-0" />
                  <div className="border-s border-white/15 ps-3">
                    <span className="block text-[11px] font-extrabold tracking-wide text-sky-300">
                      {bootstrap.clinic.englishName.toUpperCase()}
                    </span>
                    <span className="block text-[11px] text-white/80">
                      {isAr ? "تقويم • زراعة • تجميل الأسنان" : "Orthodontics • Implants • Cosmetic"}
                    </span>
                  </div>
                </div>

                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-300/40 bg-sky-400/15 px-3 py-1 text-[11px] font-bold text-sky-100">
                  <Sparkles className="h-3.5 w-3.5 text-brand-orange" aria-hidden="true" />
                  <span>{isAr ? "بوابة المريض" : "Patient Portal"}</span>
                </span>
              </div>

              {/* اسم المركز وإشراف الدكتور */}
              <div className="text-center lg:py-2">
                {bootstrap.clinic.loginPhotoVisible && <LoginPhoto />}
                <h1 className="text-lg font-extrabold leading-relaxed text-white sm:text-xl lg:text-2xl">
                  {isAr ? bootstrap.clinic.name : bootstrap.clinic.englishName}
                </h1>
                <div className="my-3 flex items-center justify-center gap-1.5" aria-hidden="true">
                  <span className="h-1 w-10 rounded-full bg-sky-400" />
                  <span className="h-1 w-5 rounded-full bg-brand-orange" />
                  <span className="h-1 w-3 rounded-full bg-white/40" />
                </div>
                {bootstrap.clinic.leadDoctor && (
                  <p className="text-xs font-medium text-sky-100/90 sm:text-sm">
                    {bootstrap.clinic.leadDoctor}
                    {bootstrap.clinic.leadDoctorTitle ? ` — ${bootstrap.clinic.leadDoctorTitle}` : ""}
                  </p>
                )}
              </div>

              {/* قسم إعلانات وأخبار المركز القابل للإدارة */}
              {bootstrap.showAnnouncements && bootstrap.announcements.length > 0 && (
                <div
                  data-testid="portal-announcements-panel"
                  className="space-y-2.5 rounded-2xl border border-white/12 bg-navy-950/35 p-4 backdrop-blur-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="inline-flex items-center gap-1.5 text-xs font-extrabold text-sky-200">
                      <Megaphone className="h-4 w-4 text-brand-orange" aria-hidden="true" />
                      <span>
                        {isAr ? "إعلانات وتنبيهات المركز" : "Center Updates & Notices"}
                      </span>
                    </h2>
                    {bootstrap.announcements.some((a) => a.isSample) && (
                      <span className="rounded-full border border-amber-300/40 bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                        {isAr ? "معاينة تجريبية" : "Sandbox Sample"}
                      </span>
                    )}
                  </div>

                  <div className="space-y-2.5">
                    {bootstrap.announcements.slice(0, 3).map((item) => {
                      const tone = TONE_CLASSES[item.tone] ?? TONE_CLASSES.sky;
                      const title = !isAr && item.titleEn ? item.titleEn : item.titleAr;
                      const body = !isAr && item.bodyEn ? item.bodyEn : item.bodyAr;
                      return (
                        <article
                          key={item.id}
                          data-testid="portal-announcement-card"
                          className={`rounded-xl border p-3 transition ${tone.border}`}
                        >
                          <div className="mb-1 flex flex-wrap items-center justify-between gap-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
                              <h3 className="text-xs font-extrabold text-white">{title}</h3>
                            </div>
                            {(item.isSample || item.badgeLabel) && (
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                                  item.isSample
                                    ? "border-amber-300/45 bg-amber-400/20 text-amber-100"
                                    : tone.badge
                                }`}
                              >
                                {item.isSample
                                  ? isAr
                                    ? "نموذج تجريبي — غير منشور"
                                    : "Sample — Unpublished"
                                  : item.badgeLabel}
                              </span>
                            )}
                          </div>
                          <p className="text-xs leading-relaxed text-slate-200/90">{body}</p>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* تذييل معلومات التواصل وأوقات الدوام */}
            <div className="relative z-10 mt-6 space-y-2 border-t border-white/12 pt-4 text-[11px] text-slate-200/85">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {bootstrap.clinic.hours && (
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-sky-300" aria-hidden="true" />
                    <span>{bootstrap.clinic.hours}</span>
                  </span>
                )}
                {bootstrap.clinic.address && (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-brand-orange" aria-hidden="true" />
                    <span>{bootstrap.clinic.address}</span>
                  </span>
                )}
                {bootstrap.clinic.phone && (
                  <a
                    href={`tel:${bootstrap.clinic.phone}`}
                    dir="ltr"
                    className="inline-flex items-center gap-1.5 font-semibold text-sky-200 hover:text-white"
                  >
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{bootstrap.clinic.phone}</span>
                  </a>
                )}
              </div>
            </div>
          </section>

          {/* لوحة نموذج الدخول / التفعيل / إعادة التعيين (تتصدر الشاشة في الجوال) */}
          <section
            aria-label={isAr ? "نموذج دخول بوابة المريض" : "Patient Portal Sign-In"}
            className="order-1 flex flex-col justify-between bg-white p-5 sm:p-8 lg:order-2 lg:col-span-6 lg:p-11"
          >
            <div className="mx-auto my-auto w-full max-w-md space-y-5">
              {/* ترويسة النموذج مع الشعار للجوال */}
              <div className="border-b border-slate-100 pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-sky-100 bg-sky-50/70 p-1.5 lg:hidden">
                      <Logo className="h-full w-full" />
                    </div>
                    <div>
                      <h2 className="text-lg font-black text-navy-900 sm:text-xl">
                        {flowMode === "activate"
                          ? isAr
                            ? "تفعيل حساب بوابة المريض"
                            : "Activate Your Portal Account"
                          : flowMode === "reset"
                            ? isAr
                              ? "تعيين كلمة مرور جديدة"
                              : "Reset Your Password"
                            : isAr
                              ? "تسجيل دخول المريض"
                              : "Patient Sign In"}
                      </h2>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {flowMode === "login"
                          ? isAr
                            ? "ادخل باسم المستخدم وكلمة المرور الخاصة بك لمتابعة مواعيدك وملفك"
                            : "Sign in with your assigned username and personal password"
                          : isAr
                            ? "رابط مؤقت أحادي الاستخدام لتعيين كلمة المرور السرية الخاصة بك"
                            : "Single-use temporary link to set your private password"}
                      </p>
                    </div>
                  </div>

                  {bootstrap.operatingMode === "sandbox_test" && (
                    <span
                      data-testid="portal-sandbox-mode-badge"
                      className="shrink-0 rounded-xl border border-sky-300 bg-sky-50 px-2.5 py-1 text-[11px] font-extrabold text-sky-900"
                    >
                      {isAr ? "وضع اختبار معزول" : "Sandbox Mode"}
                    </span>
                  )}
                </div>
              </div>

              {isOffline && (
                <div
                  role="status"
                  className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-900"
                >
                  <WifiOff className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                  <span>
                    {isAr
                      ? "يبدو أن جهازك غير متصل بالإنترنت حاليًا. تحقق من الشبكة ثم حاول مجددًا."
                      : "Your device appears to be offline. Check your connection and retry."}
                  </span>
                </div>
              )}

              {flowMode === "activate" || flowMode === "reset" ? (
                <div className="space-y-4">
                  {tokenLoading ? (
                    <div className="rounded-2xl border border-sky-100 bg-sky-50/50 p-6 text-center text-sm font-semibold text-navy-800">
                      {isAr
                        ? "جارٍ التحقق من صلاحية الرابط المؤقت…"
                        : "Verifying your temporary link…"}
                    </div>
                  ) : tokenInfo ? (
                    <>
                      <div className="rounded-2xl border border-sky-200 bg-gradient-to-r from-sky-50 to-white p-4 text-xs text-navy-900">
                        <p className="text-sm font-black text-navy-900">
                          {isAr
                            ? `مرحباً ${tokenInfo.patientFirstName}`
                            : `Welcome, ${tokenInfo.patientFirstName}`}
                        </p>
                        <p className="mt-1 text-slate-600">
                          {isAr ? "اسم المستخدم المخصّص لك: " : "Your assigned username: "}
                          <strong
                            dir="ltr"
                            className="rounded-md bg-white px-2 py-0.5 font-mono text-sm text-sky-900 shadow-2xs"
                          >
                            {tokenInfo.loginName}
                          </strong>
                        </p>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-xs font-bold text-navy-900">
                          {isAr ? "كلمة المرور الجديدة" : "New Password"}
                        </label>
                        <div className="relative">
                          <input
                            type={showPassword ? "text" : "password"}
                            autoComplete="new-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyUp={handleKeyEvent}
                            onKeyDown={handleKeyEvent}
                            dir="ltr"
                            className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3 pe-11 text-left text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-500/15"
                            placeholder="••••••••••"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={
                              showPassword
                                ? isAr
                                  ? "إخفاء كلمة المرور"
                                  : "Hide password"
                                : isAr
                                  ? "إظهار كلمة المرور"
                                  : "Show password"
                            }
                            className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-navy-800"
                          >
                            {showPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-xs font-bold text-navy-900">
                          {isAr ? "تأكيد كلمة المرور الجديدة" : "Confirm New Password"}
                        </label>
                        <input
                          type={showPassword ? "text" : "password"}
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !busy) void submitTokenPassword();
                          }}
                          dir="ltr"
                          className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3 text-left text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-500/15"
                          placeholder="••••••••••"
                        />
                      </div>

                      <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600 space-y-1">
                        <p className="flex items-center gap-1.5">
                          <CheckCircle2
                            className={`h-3.5 w-3.5 ${
                              passHasMinLen ? "text-emerald-600" : "text-slate-300"
                            }`}
                          />
                          <span>
                            {isAr
                              ? "10 خانات على الأقل (تُحفظ مشفّرة ولا يطّلع عليها أحد)"
                              : "At least 10 characters (stored hashed; never readable by staff)"}
                          </span>
                        </p>
                        <p className="flex items-center gap-1.5">
                          <CheckCircle2
                            className={`h-3.5 w-3.5 ${
                              passHasLetterAndDigit ? "text-emerald-600" : "text-slate-300"
                            }`}
                          />
                          <span>
                            {isAr
                              ? "تجمع بين حروف وأرقام لزيادة الأمان"
                              : "Includes both letters and numbers"}
                          </span>
                        </p>
                      </div>

                      {error && (
                        <div
                          role="alert"
                          className="flex items-start gap-2 rounded-xl border border-danger-200 bg-danger-50 p-3 text-xs font-bold text-danger-800"
                        >
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{error}</span>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => void submitTokenPassword()}
                        disabled={busy}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-navy-900 via-navy-800 to-sky-700 py-3 text-sm font-black text-white shadow-sm transition hover:opacity-95 disabled:opacity-50"
                      >
                        <KeyRound className="h-4 w-4" aria-hidden="true" />
                        <span>
                          {busy
                            ? isAr
                              ? "جارٍ الحفظ…"
                              : "Saving…"
                            : flowMode === "activate"
                              ? isAr
                                ? "تفعيل الحساب والدخول"
                                : "Activate & Sign In"
                              : isAr
                                ? "حفظ كلمة المرور الجديدة والدخول"
                                : "Save Password & Sign In"}
                        </span>
                      </button>
                    </>
                  ) : (
                    <div className="space-y-3">
                      {error && (
                        <div
                          role="alert"
                          className="flex items-start gap-2 rounded-xl border border-danger-200 bg-danger-50 p-3.5 text-xs font-bold text-danger-800"
                        >
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{error}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setFlowMode("login");
                          setError(null);
                        }}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
                      >
                        {isAr ? "العودة إلى شاشة تسجيل الدخول" : "Back to Sign In"}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <form
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) void submitLogin();
                  }}
                  className="space-y-4"
                >
                  <div>
                    <label
                      htmlFor="portal-username"
                      className="mb-1.5 block text-xs font-bold text-navy-900"
                    >
                      {isAr ? "اسم المستخدم" : "Username"}
                    </label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                        <User className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <input
                        id="portal-username"
                        type="text"
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={username}
                        onChange={(event) => {
                          setUsername(event.target.value);
                          if (error) setError(null);
                        }}
                        onKeyUp={handleKeyEvent}
                        onKeyDown={handleKeyEvent}
                        dir="ltr"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-3 pl-10 pr-3.5 text-left text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-500/15"
                        placeholder="patient.username"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label
                        htmlFor="portal-password"
                        className="block text-xs font-bold text-navy-900"
                      >
                        {isAr ? "كلمة المرور" : "Password"}
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowForgotHelp((v) => !v)}
                        aria-expanded={showForgotHelp}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-sky-700 hover:text-navy-900"
                      >
                        <HelpCircle className="h-3.5 w-3.5 text-brand-orange" aria-hidden="true" />
                        <span>
                          {isAr
                            ? "نسيت كلمة المرور أو تدخل لأول مرة؟"
                            : "First time or forgot password?"}
                        </span>
                      </button>
                    </div>

                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                        <Lock className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <input
                        id="portal-password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          if (error) setError(null);
                        }}
                        onKeyUp={handleKeyEvent}
                        onKeyDown={handleKeyEvent}
                        dir="ltr"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-3 pl-10 pr-11 text-left text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-500/15"
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={
                          showPassword
                            ? isAr
                              ? "إخفاء كلمة المرور"
                              : "Hide password"
                            : isAr
                              ? "إظهار كلمة المرور"
                              : "Show password"
                        }
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-navy-800"
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {capsLockOn && (
                      <p className="mt-1.5 text-[11px] font-bold text-amber-700">
                        {isAr
                          ? "تنبيه: مفتاح الأحرف الكبيرة (Caps Lock) مفعّل."
                          : "Note: Caps Lock is on."}
                      </p>
                    )}
                  </div>

                  {error && (
                    <div
                      role="alert"
                      data-testid="portal-login-error"
                      className="flex items-start gap-2 rounded-xl border border-danger-200 bg-danger-50 p-3 text-xs font-bold text-danger-800"
                    >
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={busy}
                    data-testid="portal-login-submit"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-navy-900 via-navy-800 to-sky-700 py-3 text-sm font-black text-white shadow-sm transition hover:opacity-95 disabled:opacity-50"
                  >
                    <LogIn className="h-4 w-4" aria-hidden="true" />
                    <span>
                      {busy
                        ? isAr
                          ? "جارٍ تسجيل الدخول…"
                          : "Signing in…"
                        : isAr
                          ? "دخول إلى البوابة"
                          : "Sign In to Portal"}
                    </span>
                  </button>

                  {showForgotHelp && (
                    <div
                      data-testid="portal-recovery-help"
                      className="space-y-2 rounded-2xl border border-sky-200 bg-sky-50/70 p-3.5 text-xs leading-relaxed text-navy-900"
                    >
                      <p className="font-extrabold text-navy-900">
                        {isAr
                          ? "كيف أحصل على اسم المستخدم أو أستعيد كلمة المرور؟"
                          : "How do I activate my account or recover my password?"}
                      </p>
                      <ul className="list-disc space-y-1 ps-4 text-slate-700">
                        <li>
                          {isAr
                            ? "عند التفعيل الأول: يمنحك موظف الاستقبال المخوّل اسم المستخدم الخاص بك مع رابط تفعيل مؤقت أحادي الاستخدام لتختار كلمة مرورك بنفسك."
                            : "First-time activation: authorized reception staff assigns your username and sends a single-use temporary link so you choose your own password."}
                        </li>
                        <li>
                          {isAr
                            ? "عند نسيان كلمة المرور: يتحقق الموظف من هويتك ورقم هاتفك المسجّل ثم يرسل رابط استعادة مؤقتًا عبر واتساب أو SMS."
                            : "Password reset: after verifying your identity and registered phone, staff sends a single-use reset link via WhatsApp or SMS."}
                        </li>
                        <li>
                          {isAr
                            ? "للعائلات المشتركة في رقم هاتف واحد أو عند تغيّر الرقم: يتم التحقق حضوريًا لحماية استقلال كل ملف طبي."
                            : "Shared family phones or changed numbers require in-person verification to keep every patient record isolated."}
                        </li>
                      </ul>
                    </div>
                  )}

                  {bootstrap.showBookingLink && (
                    <div className="border-t border-slate-100 pt-3">
                      <Link
                        href="/book"
                        className="flex items-center justify-center gap-2 rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-2.5 text-xs font-extrabold text-navy-900 transition hover:border-sky-300 hover:bg-sky-100/70"
                      >
                        <CalendarPlus className="h-4 w-4 text-sky-700" aria-hidden="true" />
                        <span>
                          {isAr
                            ? "مراجع جديد أو ترغب بطلب حجز موعد؟ انتقل إلى صفحة الحجز"
                            : "Need to request an appointment? Go to Booking Request"}
                        </span>
                      </Link>
                    </div>
                  )}
                </form>
              )}
            </div>

            <div className="mt-6 border-t border-slate-100 pt-3 text-center text-[11px] text-slate-400">
              {isAr
                ? "لا تُحفظ كلمات المرور بصيغة قابلة للقراءة، وتُبطل الجلسات السابقة تلقائيًا عند تغيير كلمة المرور."
                : "Passwords are never stored in readable form, and old sessions are automatically revoked upon password change."}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
