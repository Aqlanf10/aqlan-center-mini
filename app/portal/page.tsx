"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarPlus, Globe, Type, WifiOff } from "lucide-react";
import {
  PortalAdminPreviewBanner,
  PortalLoginAndTokenScreen,
  type PortalLang,
  type PortalSessionInfo,
  type PortalVisibleSectionsView,
} from "@/components/PortalAccountFlow";
import {
  PortalClinicalSection,
  PortalDocumentsSection,
  PortalPrescriptionsSection,
  PortalProfileCard,
  PortalSecuritySection,
} from "@/components/portal/PortalSections";
import { Logo } from "@/components/Icon";
import {
  ChatComposer,
  daySeparatorLabel,
  MessageBubble,
  playNewMessageChime,
  type ChatMessage,
} from "@/components/Chat";
import { messagePreview } from "@/lib/messages";
import { CURRENCY_LABEL, activeBalanceCurrencies, formatMoney } from "@/lib/money";
import { INTAKE_CONDITIONS, type IntakeAnswers } from "@/lib/portal-intake-fields";
import type { PortalHistoricalTreatment, PortalStatement } from "@/lib/portal-statement";
import { friendlyDate, friendlyDateLong } from "@/lib/reminders";

/**
 * بوابة المريض — مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان.
 *
 * كل قسم يُعرض وفق سياسات الإظهار التي تضبطها الإدارة من `/settings/patient-portal`،
 * وكل رقم وسجل سريري يأتي من مصدر الحقيقة المعتمد في العيادة:
 * الزيارات الموقّعة فقط، وخطط العلاج المعتمدة، وكشف الحساب المطابق للمطبوع،
 * والروشتات الفعّالة، والمستندات المسموح بها، والمحادثة الآمنة مع فريق المركز.
 */

type Tab =
  | "appointments"
  | "clinical"
  | "prescriptions"
  | "statement"
  | "documents"
  | "intake"
  | "messages"
  | "security";

interface PortalAppointmentView {
  id: number;
  scheduledDate: string;
  scheduledTime: string;
  durationMinutes: number;
  appointmentType: string | null;
  note: string | null;
  patientConfirmedAt: string | null;
  confirmable: boolean;
}

interface PortalPastAppointmentView {
  id: number;
  scheduledDate: string;
  scheduledTime: string;
  durationMinutes: number;
  appointmentType: string | null;
  status: string;
}

type StatementFeed = PortalStatement;

const DEFAULT_VISIBLE_SECTIONS: PortalVisibleSectionsView = {
  profile: true,
  appointments: true,
  allowAppointmentConfirm: true,
  showBookingLink: true,
  visits: true,
  treatmentPlans: true,
  statement: true,
  prescriptions: true,
  documents: true,
  xrayDocuments: false,
  intake: true,
  messages: true,
  allowMessageAttachments: true,
  allowVoiceMessages: true,
  announcements: true,
};

const PAST_STATUS_LABEL_AR: Record<string, string> = {
  booked: "محجوز",
  arrived: "حضر",
  completed: "مكتمل",
  cancelled: "ملغى",
  no_show: "لم يحضر",
};

export default function PortalPage() {
  const [session, setSession] = useState<PortalSessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("appointments");
  const [lang, setLang] = useState<PortalLang>("ar");
  const [largeText, setLargeText] = useState(false);
  const [offline, setOffline] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/me", { cache: "no-store" });
      if (response.ok) setSession(await response.json());
      else setSession(null);
    } catch {
      setSession(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    const syncOnline = () => setOffline(!navigator.onLine);
    syncOnline();
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);

  useEffect(() => {
    if (
      session &&
      !session.adminPreview &&
      new URLSearchParams(window.location.search).get("next") === "/checkin"
    ) {
      window.location.replace("/checkin");
    }
  }, [session]);

  const visible = session?.visibleSections ?? DEFAULT_VISIBLE_SECTIONS;
  const isEn = lang === "en";
  const readOnly = Boolean(session?.adminPreview);

  const availableTabs = useMemo(() => {
    const items: { key: Tab; label: string }[] = [];
    if (visible.appointments) {
      items.push({ key: "appointments", label: isEn ? "Appointments" : "مواعيدي" });
    }
    if (visible.visits || visible.treatmentPlans) {
      items.push({ key: "clinical", label: isEn ? "Visits & Care" : "زياراتي وعلاجي" });
    }
    if (visible.prescriptions) {
      items.push({ key: "prescriptions", label: isEn ? "Prescriptions" : "روشتاتي" });
    }
    if (visible.statement) {
      // Exact Arabic label "حسابي" preserved for UI & contract tests
      items.push({ key: "statement", label: isEn ? "Statement" : "حسابي" });
    }
    if (visible.documents) {
      items.push({ key: "documents", label: isEn ? "Documents" : "مستنداتي" });
    }
    if (visible.intake) {
      items.push({ key: "intake", label: isEn ? "Health Form" : "استمارتي" });
    }
    if (visible.messages) {
      items.push({ key: "messages", label: isEn ? "Messages" : "الرسائل" });
    }
    items.push({ key: "security", label: isEn ? "Security" : "أمان الحساب" });
    return items;
  }, [visible, isEn]);

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.some((t) => t.key === tab)) {
      setTab(availableTabs[0].key);
    }
  }, [availableTabs, tab]);

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-sm font-bold text-slate-500">
        جارٍ التحقق من الجلسة…
      </main>
    );
  }

  if (!session) {
    return (
      <PortalLoginAndTokenScreen
        onLogin={(next) => {
          setSession(next);
          setTab("appointments");
        }}
      />
    );
  }

  return (
    <div
      dir={isEn ? "ltr" : "rtl"}
      className={`min-h-screen bg-gradient-to-b from-sky-50/50 via-slate-50 to-white ${
        largeText ? "text-[17px]" : ""
      }`}
    >
      {/* الشريط العلوي بهوية مركز الدكتور عقلان الكامل مع السماوي المنسجم */}
      <div className="border-b border-sky-200/70 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Logo className="h-10 w-10 shrink-0" />
            <div>
              <p className="text-[11px] font-black text-sky-700">
                {isEn
                  ? "Dr. Aqlan Dental Center · Patient Portal"
                  : "مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-black text-navy-900 sm:text-lg">{session.fullName}</h1>
                <span className="rounded-full bg-sky-50 px-2.5 py-0.5 font-mono text-xs font-bold text-sky-900 border border-sky-200">
                  {isEn ? `File #${session.patientNumber}` : `ملف رقم ${session.patientNumber}`}
                </span>
                {session.operatingMode === "sandbox_test" && (
                  <span
                    data-testid="portal-sandbox-mode-badge"
                    className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-black text-amber-900"
                  >
                    {isEn ? "Isolated Sandbox Test" : "وضع اختبار معزول"}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLargeText((v) => !v)}
              aria-pressed={largeText}
              title={isEn ? "Toggle larger text" : "تكبير النص لتسهيل القراءة"}
              className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-xs font-black transition-colors ${
                largeText
                  ? "border-sky-400 bg-sky-100 text-sky-950"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <Type className="h-3.5 w-3.5" aria-hidden="true" />
              A+
            </button>

            <button
              type="button"
              onClick={() => setLang((cur) => (cur === "ar" ? "en" : "ar"))}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-black text-slate-700 hover:bg-slate-50"
            >
              <Globe className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
              {isEn ? "العربية" : "EN"}
            </button>

            <button
              type="button"
              onClick={async () => {
                if (session.adminPreview) {
                  const res = await fetch("/api/portal/admin-preview/exit", { method: "POST" });
                  const data = await res.json().catch(() => null);
                  setSession(null);
                  window.location.assign(typeof data?.returnTo === "string" ? data.returnTo : "/");
                  return;
                }
                await fetch("/api/portal/logout", { method: "POST" });
                setSession(null);
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 hover:border-danger-300 hover:text-danger-700"
            >
              {session.adminPreview
                ? isEn
                  ? "Exit Admin Preview"
                  : "إنهاء العرض الإداري"
                : isEn
                  ? "Sign Out"
                  : "خروج"}
            </button>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-4xl p-4 pb-20">
        {offline && (
          <div
            role="status"
            className="mb-4 flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold text-amber-950"
          >
            <WifiOff className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
            <span>
              {isEn
                ? "Internet connection appears offline. Reconnect before submitting updates."
                : "يبدو أن الاتصال بالإنترنت مقطوع حاليًا. تحقق من الشبكة قبل إرسال أي تحديث."}
            </span>
          </div>
        )}

        {session.adminPreview && (
          <PortalAdminPreviewBanner
            preview={session.adminPreview}
            onExited={(returnTo) => {
              setSession(null);
              window.location.assign(returnTo);
            }}
          />
        )}

        {visible.profile && session.profile && (
          <PortalProfileCard profile={session.profile} lang={lang} />
        )}

        <nav
          aria-label={isEn ? "Portal Sections" : "أقسام بوابة المريض"}
          className="mb-5 flex gap-2 overflow-x-auto pb-1 sm:flex-wrap"
        >
          {availableTabs.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setTab(option.key)}
              className={
                tab === option.key
                  ? "shrink-0 rounded-xl bg-navy-800 px-3.5 py-2 text-xs font-black text-white shadow-xs ring-2 ring-sky-300/60 sm:text-sm"
                  : "shrink-0 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 hover:border-sky-300 hover:bg-sky-50/40 sm:text-sm"
              }
            >
              {option.label}
            </button>
          ))}
        </nav>

        {tab === "appointments" && <AppointmentsTab readOnly={readOnly} lang={lang} />}
        {tab === "clinical" && <PortalClinicalSection lang={lang} />}
        {tab === "prescriptions" && <PortalPrescriptionsSection lang={lang} />}
        {tab === "statement" && <StatementTab />}
        {tab === "documents" && <PortalDocumentsSection lang={lang} />}
        {tab === "intake" && <IntakeTab readOnly={readOnly} lang={lang} />}
        {tab === "messages" && (
          <MessagesTab
            readOnly={readOnly}
            allowAttachments={visible.allowMessageAttachments}
            allowVoice={visible.allowVoiceMessages}
          />
        )}
        {tab === "security" && (
          <PortalSecuritySection
            readOnly={readOnly}
            lang={lang}
            onSignedOutAll={() => setSession(null)}
          />
        )}
      </main>
    </div>
  );
}

function AppointmentsTab({
  readOnly = false,
  lang = "ar",
}: {
  readOnly?: boolean;
  lang?: PortalLang;
}) {
  const isEn = lang === "en";
  const [feed, setFeed] = useState<{
    today: string;
    appointments: PortalAppointmentView[];
    pastAppointments?: PortalPastAppointmentView[];
    allowConfirm?: boolean;
    showBookingLink?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/appointments", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async (id: number) => {
    if (readOnly) return;
    setBusyId(id);
    try {
      const response = await fetch("/api/portal/appointments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التأكيد.");
      await load();
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "تعذّر التأكيد.");
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return (
      <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
        {error}
      </p>
    );
  }
  if (!feed) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;

  const pastList = feed.pastAppointments ?? [];
  const showBookLink = feed.showBookingLink !== false && !readOnly;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-black text-navy-900">
          {isEn ? "Upcoming Appointments" : "المواعيد القادمة"}
        </h2>
        {showBookLink && (
          <Link
            href="/book"
            className="inline-flex items-center gap-1.5 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-black text-sky-900 hover:bg-sky-100"
          >
            <CalendarPlus className="h-3.5 w-3.5 text-sky-700" aria-hidden="true" />
            {isEn ? "Request Appointment" : "طلب حجز موعد جديد"}
          </Link>
        )}
      </div>

      {feed.appointments.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          {isEn
            ? "No upcoming appointments in your file. Use Request Appointment or contact reception."
            : "لا مواعيد قادمة في ملفك. لطلب موعد استخدم صفحة طلب الموعد أو اتصل بالاستقبال."}
        </p>
      ) : (
        <section className="space-y-3">
          {feed.appointments.map((appointment) => (
            <article
              key={appointment.id}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black text-navy-900">{friendlyDate(appointment.scheduledDate)}</p>
                  <p className="text-sm text-slate-600">
                    الساعة {appointment.scheduledTime} · {appointment.durationMinutes} دقيقة
                  </p>
                  {appointment.appointmentType && (
                    <p className="text-xs font-semibold text-sky-800">{appointment.appointmentType}</p>
                  )}
                  {appointment.note && (
                    <p className="mt-1 text-xs text-slate-500">{appointment.note}</p>
                  )}
                </div>
                {appointment.patientConfirmedAt ? (
                  <span className="rounded-lg bg-success-100 px-2.5 py-1 text-xs font-black text-success-800">
                    مؤكد الحضور ✓
                  </span>
                ) : appointment.confirmable && feed.allowConfirm !== false && !readOnly ? (
                  <button
                    type="button"
                    onClick={() => void confirm(appointment.id)}
                    disabled={busyId === appointment.id}
                    className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-black text-white hover:bg-navy-900 disabled:opacity-50"
                  >
                    {busyId === appointment.id ? "…" : "أؤكد حضورى"}
                  </button>
                ) : (
                  <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">
                    {readOnly ? "قراءة فقط" : "مسجّل"}
                  </span>
                )}
              </div>
            </article>
          ))}
        </section>
      )}

      {pastList.length > 0 && (
        <section className="space-y-2.5 pt-2">
          <h3 className="text-xs font-black text-slate-600">
            {isEn ? "Previous Appointments History" : "سجل المواعيد السابقة"}
          </h3>
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4">
            {pastList.map((past) => (
              <div key={past.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                <div>
                  <span className="font-bold text-navy-900">{friendlyDate(past.scheduledDate)}</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span className="text-slate-600">{past.scheduledTime}</span>
                  {past.appointmentType && (
                    <span className="mx-1.5 text-slate-500">({past.appointmentType})</span>
                  )}
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-bold text-slate-600">
                  {isEn ? past.status : PAST_STATUS_LABEL_AR[past.status] ?? past.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatementTab() {
  const [feed, setFeed] = useState<StatementFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/portal/statement", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
        setFeed(payload as StatementFeed);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
      }
    })();
  }, []);

  if (error) {
    return (
      <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
        {error}
      </p>
    );
  }
  if (!feed) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;

  // بطاقةٌ لكل عملةٍ فيها حركة — دَينٌ بالسعودي وحده لا يظهر «حسابًا مسدّدًا» باليمني.
  const currencies = activeBalanceCurrencies(feed.balances, feed.baseCurrency);
  return (
    <section className="space-y-4">
      {currencies.map((currency) => {
        const bucket = feed.balances[currency];
        const due = bucket.dueMinor;
        return (
          <div
            key={currency}
            className={`rounded-2xl border p-4 ${
              due > 0
                ? "border-warning-300 bg-warning-50"
                : due < 0
                  ? "border-slate-200 bg-white"
                  : "border-success-300 bg-success-50"
            }`}
          >
            <p className="text-xs font-bold text-slate-600">
              {due > 0 ? "المتبقي على حسابك" : due < 0 ? "رصيد لصالحك عندنا" : "الحساب مسدّد"}
              {currencies.length > 1 ? ` — ${CURRENCY_LABEL[currency]}` : ""}
            </p>
            <p className="mt-1 text-2xl font-black tabular-nums text-navy-900">
              {formatMoney(Math.abs(due), currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              إجمالي الفواتير {formatMoney(bucket.billedMinor, currency)} · المسدَّد{" "}
              {formatMoney(bucket.collectedMinor, currency)}
              {bucket.openingMinor !== 0 &&
                ` · رصيد سابق ${formatMoney(bucket.openingMinor, currency)}`}
            </p>
          </div>
        );
      })}

      {feed.openings.map((opening) => (
        <div key={opening.currency} className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
          <p className="font-bold text-slate-700">رصيد سابق على النظام (بقبل {opening.asOfDate})</p>
          <p className="tabular-nums text-slate-600">
            {formatMoney(opening.amountMinor, opening.currency)}
          </p>
        </div>
      ))}

      <HistoricalTreatment historical={feed.historical} />

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-black text-navy-900">الفواتير</h2>
        {feed.invoices.length === 0 ? (
          <p className="text-sm text-slate-500">لا فواتير بعد.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {feed.invoices.map((invoice) => (
              <li key={invoice.invoiceNumber} className="py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{invoice.invoiceNumber}</span>
                  <span className="text-slate-500">{friendlyDate(invoice.createdAt.slice(0, 10))}</span>
                  <span className="tabular-nums">
                    {formatMoney(invoice.netMinor, invoice.baseCurrency)}
                    {invoice.discountMinor > 0 && (
                      <small className="text-slate-500">
                        {" "}
                        (بعد خصم {formatMoney(invoice.discountMinor, invoice.baseCurrency)})
                      </small>
                    )}
                  </span>
                  <span className={invoice.status === "paid" ? "text-success-800" : "text-warning-700"}>
                    {invoice.status === "paid" ? "مسدّدة" : "مفتوحة"}
                  </span>
                </div>
                {/* The same treatment lines as the printed statement, at the stored invoice prices. */}
                {invoice.items.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">تفاصيل البنود غير مسجلة لهذه الفاتورة</p>
                ) : (
                  <table
                    className="mt-2 w-full table-fixed text-xs"
                    aria-label={`بنود الفاتورة ${invoice.invoiceNumber}`}
                  >
                    <thead className="text-slate-500">
                      <tr>
                        <th className="w-1/2 text-start font-bold">العلاج / البيان</th>
                        <th className="text-end font-bold">الكمية</th>
                        <th className="text-end font-bold">سعر الوحدة</th>
                        <th className="text-end font-bold">إجمالي البند</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.items.map((item, index) => (
                        <tr key={index}>
                          <td className="break-words">{item.description}</td>
                          <td className="text-end tabular-nums">{item.quantity}</td>
                          <td className="text-end tabular-nums">
                            {formatMoney(item.unitPriceMinor, invoice.baseCurrency)}
                          </td>
                          <td className="text-end tabular-nums">
                            {formatMoney(item.totalMinor, invoice.baseCurrency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {feed.agreementsRequireReview ? (
        <p role="status" className="rounded-xl border border-amber-200 p-3 text-sm">
          بعض أرصدة اتفاقات العلاج غير متاحة وتحتاج مراجعة مصدرها. الفواتير وكشف الحساب المعروضان
          مستقلان عن هذا الملخص.
        </p>
      ) : null}
      {feed.agreements.map((agreement, index) => (
        <div key={index} className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
          <h2 className="mb-2 text-sm font-black text-navy-900">اتفاق العلاج — {agreement.title}</h2>
          <p className="flex justify-between">
            <span>إجمالي الاتفاق</span>
            <span className="tabular-nums">{formatMoney(agreement.totalMinor, agreement.currency)}</span>
          </p>
          <p className="flex justify-between">
            <span>المسدّد من الاتفاق</span>
            <span className="tabular-nums">{formatMoney(agreement.paidMinor, agreement.currency)}</span>
          </p>
          <p className="flex justify-between font-bold">
            <span>المتبقي من الاتفاق</span>
            <span className="tabular-nums">
              {formatMoney(agreement.remainingMinor, agreement.currency)}
            </span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            المتبقي من الاتفاق يشمل الأقساط المستقبلية ولا يعني أن كامل المبلغ مستحق الآن.
          </p>
        </div>
      ))}

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-black text-navy-900">الدفعات</h2>
        {feed.payments.length === 0 ? (
          <p className="text-sm text-slate-500">لا دفعات بعد.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {feed.payments.map((payment) => (
              <li key={payment.receiptNumber} className="flex items-center justify-between py-2 text-sm">
                <span className="font-bold">{payment.receiptNumber}</span>
                <span className="text-slate-500">{friendlyDate(payment.createdAt.slice(0, 10))}</span>
                <span className="text-slate-600">{payment.label}</span>
                <span className="tabular-nums">
                  {payment.kind === "refund" ? "−" : ""}
                  {formatMoney(payment.amountMinor, payment.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** «العلاج السابق»: the same saved historical agreements and labels as the current printed statement. */
function HistoricalTreatment({ historical }: { historical: PortalHistoricalTreatment }) {
  if (!historical.available) {
    return (
      <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        تفاصيل العلاج السابق غير متاحة حاليًا، والأرصدة المعروضة لا تعتمد عليها. راجع المركز للاطلاع
        على التفاصيل.
      </p>
    );
  }
  // As on the print: only genuine historical treatment opens this section.
  if (historical.agreements.length === 0) return null;
  return (
    <section aria-label="العلاج السابق" className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-black text-navy-900">العلاج السابق</h2>
      <div className="space-y-4">
        {historical.agreements.map((agreement, index) => {
          const money = (minor: number | null) =>
            minor === null ? "غير مسجل" : formatMoney(minor, agreement.currency);
          const heading = `اتفاق علاج بتاريخ ${friendlyDateLong(agreement.historicalAsOf)}`;
          return (
            <div key={index} className="text-xs">
              <h3 className="mb-1 text-sm font-bold text-slate-700">{heading}</h3>
              <table className="w-full table-fixed" aria-label={heading}>
                <thead className="text-slate-500">
                  <tr>
                    <th className="w-1/3 text-start font-bold">العلاج / البيان</th>
                    <th className="text-start font-bold">الموضع</th>
                    <th className="text-end font-bold">الكمية</th>
                    <th className="text-end font-bold">سعر الوحدة</th>
                    <th className="text-end font-bold">الخصم</th>
                    <th className="text-end font-bold">الصافي</th>
                  </tr>
                </thead>
                <tbody>
                  {agreement.lines.map((line, lineIndex) => (
                    <tr key={lineIndex}>
                      <td className="break-words">{line.description}</td>
                      <td>{line.site ?? "—"}</td>
                      <td className="text-end tabular-nums">{line.quantity}</td>
                      <td className="text-end tabular-nums">{money(line.unitPriceMinor)}</td>
                      <td className="text-end tabular-nums">{money(line.discountMinor)}</td>
                      <td className="text-end tabular-nums">{money(line.netMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="mt-2 space-y-1 text-sm">
                {agreement.grossMinor !== null && agreement.discountMinor !== null && (
                  <>
                    <div className="flex justify-between">
                      <dt>الإجمالي قبل الخصم</dt>
                      <dd className="tabular-nums">{money(agreement.grossMinor)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>الخصم المسجل</dt>
                      <dd className="tabular-nums">{money(agreement.discountMinor)}</dd>
                    </div>
                  </>
                )}
                <div className="flex justify-between">
                  <dt>المبلغ المتفق عليه</dt>
                  <dd className="tabular-nums">{money(agreement.agreedMinor)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>المدفوع من قبل</dt>
                  <dd className="tabular-nums">{money(agreement.previouslyPaidMinor)}</dd>
                </div>
                <div className="flex justify-between font-bold">
                  <dt>المبلغ المتبقي</dt>
                  <dd className="tabular-nums">{money(agreement.remainingMinor)}</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
      {historical.undetailed.map((entry) => (
        <p key={entry.currency} className="mt-2 text-xs text-slate-500">
          {entry.partial ? "جزء من الرصيد السابق" : "الرصيد السابق"} ({CURRENCY_LABEL[entry.currency]})
          بلا تفاصيل علاج مسجلة.
        </p>
      ))}
    </section>
  );
}

function IntakeTab({
  readOnly = false,
  lang = "ar",
}: {
  readOnly?: boolean;
  lang?: PortalLang;
}) {
  const isEn = lang === "en";
  const [latest, setLatest] = useState<{ createdAt: string; answers: IntakeAnswers } | null>(null);
  const [conditions, setConditions] = useState<string[]>([]);
  const [allergies, setAllergies] = useState("");
  const [medications, setMedications] = useState("");
  const [emergencyName, setEmergencyName] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/portal/intake", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
        if (payload.latest) {
          setLatest(payload.latest);
          setConditions(payload.latest.answers.conditions ?? []);
          setAllergies(payload.latest.answers.allergies ?? "");
          setMedications(payload.latest.answers.medications ?? "");
          setEmergencyName(payload.latest.answers.emergencyName ?? "");
          setEmergencyPhone(payload.latest.answers.emergencyPhone ?? "");
          setNote(payload.latest.answers.note ?? "");
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
      }
    })();
  }, []);

  const submit = async () => {
    if (readOnly) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/portal/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conditions,
          allergies,
          medications,
          emergencyName,
          emergencyPhone,
          note,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الإرسال.");
      setLatest({
        createdAt: payload.createdAt,
        answers: { conditions, allergies, medications, emergencyName, emergencyPhone, note },
      });
      setSaved(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "تعذّر الإرسال.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      {readOnly && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold text-amber-950">
          {isEn
            ? "Admin Read-Only Preview: Health intake form is displayed in read-only mode."
            : "عرض إداري للقراءة فقط: تُعرض استمارة المريض الصحية للاطلاع دون السماح بإرسال تعديل باسم المريض."}
        </p>
      )}
      {latest && (
        <p className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-500">
          آخر استمارة مُرسلة: {friendlyDate(latest.createdAt.slice(0, 10))}. كل إرسال نسخة جديدة —
          الطاقم يقرأ الأحدث.
        </p>
      )}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-black text-navy-900">حالات مزمنة (أشِر ما ينطبق)</h2>
        <div className="flex flex-wrap gap-2">
          {INTAKE_CONDITIONS.map((condition) => {
            const active = conditions.includes(condition.key);
            return (
              <button
                key={condition.key}
                type="button"
                disabled={readOnly}
                onClick={() =>
                  setConditions((list) =>
                    active ? list.filter((key) => key !== condition.key) : [...list, condition.key],
                  )
                }
                className={
                  active
                    ? "rounded-full bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-70"
                    : "rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 disabled:opacity-60"
                }
              >
                {condition.label}
              </button>
            );
          })}
        </div>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-700">حساسية (أدوية، مواد)</span>
            <textarea
              value={allergies}
              disabled={readOnly}
              onChange={(event) => setAllergies(event.target.value)}
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 disabled:bg-slate-50"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-700">أدوية تتناولها حاليًا</span>
            <textarea
              value={medications}
              disabled={readOnly}
              onChange={(event) => setMedications(event.target.value)}
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 disabled:bg-slate-50"
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-slate-700">جهة اتصال طارئة</span>
              <input
                type="text"
                value={emergencyName}
                disabled={readOnly}
                onChange={(event) => setEmergencyName(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 disabled:bg-slate-50"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-slate-700">هاتف الطوارئ</span>
              <input
                type="tel"
                dir="ltr"
                value={emergencyPhone}
                disabled={readOnly}
                onChange={(event) => setEmergencyPhone(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left disabled:bg-slate-50"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-700">ملاحظات للطبيب</span>
            <textarea
              value={note}
              disabled={readOnly}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 disabled:bg-slate-50"
            />
          </label>
        </div>
        {error && (
          <p className="mt-3 rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
            {error}
          </p>
        )}
        {saved && (
          <p className="mt-3 rounded-xl border border-success-200 bg-success-50 p-3 text-sm font-bold text-success-800">
            وصلت استمارتك — سيراها الطاقم قبل زيارتك القادمة.
          </p>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="mt-4 w-full rounded-xl bg-navy-800 py-2.5 text-sm font-black text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {busy ? "جارٍ الإرسال…" : "إرسال الاستمارة"}
          </button>
        )}
      </div>
    </section>
  );
}

function MessagesTab({
  readOnly = false,
  allowAttachments = true,
  allowVoice = true,
}: {
  readOnly?: boolean;
  allowAttachments?: boolean;
  allowVoice?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverAllowsAttachments, setServerAllowsAttachments] = useState(allowAttachments);
  const [serverAllowsVoice, setServerAllowsVoice] = useState(allowVoice);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyTo, setReplyTo] = useState<{ id: number; name: string; preview: string } | null>(null);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastSeenIdRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/messages", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المحادثة.");
      const next: ChatMessage[] = payload.messages ?? [];
      if (typeof payload.allowAttachments === "boolean") {
        setServerAllowsAttachments(payload.allowAttachments);
      }
      if (typeof payload.allowVoice === "boolean") {
        setServerAllowsVoice(payload.allowVoice);
      }
      const lastId = next.at(-1)?.id ?? null;
      const prevSeen = lastSeenIdRef.current;
      if (lastId !== null && prevSeen !== null && lastId > prevSeen) {
        const reply = next.find(
          (message) => message.id > prevSeen && message.senderType === "user",
        );
        if (reply) playNewMessageChime();
      }
      lastSeenIdRef.current = lastId ?? prevSeen;
      setMessages(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل المحادثة.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = useCallback(
    async (payload: {
      body?: string;
      kind: "text" | "voice" | "file";
      voiceMime?: string;
      voiceData?: string;
      voiceMs?: number;
      fileName?: string;
      fileMime?: string;
      fileSize?: number;
      fileData?: string;
      urgent?: boolean;
      replyToId?: number | null;
    }) => {
      const response = await fetch("/api/portal/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created?.message ?? "تعذّر إرسال الرسالة.");
      setMessages((current) => [...current, created as ChatMessage]);
      lastSeenIdRef.current = created.id;
      setReplyTo(null);
    },
    [],
  );

  const saveEdit = useCallback(
    async (body: string) => {
      if (!editing) return;
      const response = await fetch("/api/portal/messages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editing.id, body }),
      });
      const updated = await response.json();
      if (!response.ok) throw new Error(updated?.message ?? "تعذّر تعديل الرسالة.");
      setMessages((current) =>
        current.map((message) => (message.id === editing.id ? (updated as ChatMessage) : message)),
      );
      setEditing(null);
    },
    [editing],
  );

  const deleteMessage = useCallback(async (message: ChatMessage) => {
    if (!window.confirm("حذف هذه الرسالة؟ سيظهر مكانها «حُذفت هذه الرسالة» عند العيادة.")) return;
    const response = await fetch(`/api/portal/messages?id=${message.id}`, { method: "DELETE" });
    const updated = await response.json();
    if (!response.ok) {
      setError(updated?.message ?? "تعذّر حذف الرسالة.");
      return;
    }
    setMessages((current) =>
      current.map((entry) => (entry.id === message.id ? (updated as ChatMessage) : entry)),
    );
  }, []);

  const startReply = useCallback((message: ChatMessage) => {
    setEditing(null);
    setReplyTo({
      id: message.id,
      name: message.senderName ?? "العيادة",
      preview: message.deletedAt
        ? "رسالة محذوفة"
        : messagePreview(message.kind, message.body, message.voiceMs, message.fileName),
    });
  }, []);

  const groups: { label: string; items: ChatMessage[] }[] = [];
  for (const message of messages) {
    const label = daySeparatorLabel(message.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(message);
    else groups.push({ label, items: [message] });
  }

  return (
    <section className="flex h-[32rem] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-card">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-black text-sky-900">
          عيادتك
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-navy-900">محادثة العيادة</p>
          <p className="text-[11px] font-semibold text-slate-400">
            رسالتك تصل إلى فريق العيادة كله — والزر الأحمر «عاجلة» لما لا ينتظر.
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {loading && <p className="text-center text-sm text-slate-400">جارٍ التحميل…</p>}
        {error && (
          <p
            className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800"
            role="alert"
          >
            {error}
          </p>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-xs text-center text-sm text-slate-400">
              لا رسائل بعد — اكتب سؤالك أو استفسارك وسيجيبك فريق العيادة هنا.
            </p>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.label} className="space-y-2.5">
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="rounded-full bg-white px-3 py-0.5 text-[10px] font-black text-slate-400 shadow-xs">
                {group.label}
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            {group.items.map((message) => (
              <div key={message.id} className="space-y-0.5">
                <MessageBubble
                  message={message}
                  mine={message.senderType === "patient"}
                  onReply={readOnly ? undefined : startReply}
                  onEdit={
                    readOnly
                      ? undefined
                      : (target) => setEditing({ id: target.id, body: target.body ?? "" })
                  }
                  onDelete={readOnly ? undefined : deleteMessage}
                />
                {message.senderType === "user" && message.senderName && (
                  <p className="pr-2 text-[10px] font-bold text-slate-400">{message.senderName}</p>
                )}
              </div>
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-slate-200 bg-white p-3">
        {readOnly ? (
          <p className="text-center text-xs font-bold text-amber-900">
            عرض إداري للقراءة فقط — إرسال الرسائل أو تعديلها باسم المريض موقوف في هذا العرض.
          </p>
        ) : (
          <ChatComposer
            placeholder="اكتب رسالتك للعيادة…"
            allowUrgent
            allowVoice={serverAllowsVoice}
            allowFile={serverAllowsAttachments}
            onSendText={(body, options) =>
              send({
                body,
                kind: "text",
                urgent: options?.urgent,
                replyToId: options?.replyToId ?? null,
              })
            }
            onSendVoice={(voice, options) =>
              send({
                kind: "voice",
                voiceMime: voice.mime,
                voiceData: voice.data,
                voiceMs: voice.ms,
                replyToId: options?.replyToId ?? null,
              })
            }
            onSendFile={(file, options) =>
              send({
                kind: "file",
                body: file.caption ?? undefined,
                fileName: file.name,
                fileMime: file.mime,
                fileSize: file.size,
                fileData: file.data,
                replyToId: options?.replyToId ?? null,
              })
            }
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            editing={editing}
            onSaveEdit={saveEdit}
            onCancelEdit={() => setEditing(null)}
          />
        )}
      </footer>
    </section>
  );
}
