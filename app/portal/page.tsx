"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Icon";
import {
  ChatComposer,
  daySeparatorLabel,
  MessageBubble,
  playNewMessageChime,
  type ChatMessage,
} from "@/components/Chat";
import { formatMoney } from "@/lib/money";
import { INTAKE_CONDITIONS, type IntakeAnswers } from "@/lib/portal";
import { friendlyDate } from "@/lib/reminders";

/**
 * بوابة المريض.
 *
 * أربع شاشات لا أكثر: مواعيدي، وحسابي، واستمارتي، والرسائل. كل رقم فيها يأتي من مصدر
 * الحقيقة نفسه الذي تقرأه العيادة — فما يراه المريض هنا هو ما يراه الكاشير
 * هناك، بالبنية لا بالمراجعة.
 *
 * تسجيل الدخول بهاتفٍ ورقم ملف: عاملان يعرفهما صاحب الملف، وبحدّ لمحاولات
 * الدخول يجعل التخمين عبثًا. لا كلمة سرّ تُنسى ولا حساب يُدار — المريض يدخل
 * يقرأ ويؤكد ويخرج، ويراسل العيادة فيرى ردّها هنا.
 */

type Tab = "appointments" | "statement" | "intake" | "messages";

const TABS: { key: Tab; label: string }[] = [
  { key: "appointments", label: "مواعيدي" },
  { key: "statement", label: "حسابي" },
  { key: "intake", label: "استمارتي" },
  { key: "messages", label: "الرسائل" },
];

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

interface StatementFeed {
  invoices: {
    invoiceNumber: string; createdAt: string; totalMinor: number;
    discountMinor: number; status: string;
  }[];
  payments: {
    receiptNumber: string; createdAt: string; amountMinor: number;
    currency: "YER" | "SAR" | "USD"; kind: string;
  }[];
  opening: { amountMinor: number; asOfDate: string } | null;
  balance: { billedMinor: number; collectedMinor: number; openingMinor: number; dueMinor: number };
  baseCurrency: "YER" | "SAR" | "USD";
}

export default function PortalPage() {
  const [session, setSession] = useState<{ fullName: string; patientNumber: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("appointments");

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

  useEffect(() => { void checkSession(); }, [checkSession]);

  if (checking) {
    return <main className="flex min-h-screen items-center justify-center p-6 text-sm text-slate-500">…</main>;
  }

  if (!session) {
    return <LoginScreen onLogin={(next) => { setSession(next); setTab("appointments"); }} />;
  }

  return (
    <main className="mx-auto max-w-2xl p-4 pb-16">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500">مرحًا بك</p>
          <h1 className="text-lg font-black text-navy-900">{session.fullName}</h1>
          <p className="text-xs text-slate-500">ملف رقم {session.patientNumber}</p>
        </div>
        <button
          onClick={async () => { await fetch("/api/portal/logout", { method: "POST" }); setSession(null); }}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:border-danger-300 hover:text-danger-700">
          خروج
        </button>
      </header>

      <nav className="mb-5 grid grid-cols-4 gap-2">
        {TABS.map((option) => (
          <button key={option.key} onClick={() => setTab(option.key)}
            className={tab === option.key
              ? "rounded-xl bg-navy-800 py-2 text-sm font-bold text-white"
              : "rounded-xl border border-slate-200 bg-white py-2 text-sm font-bold text-slate-700"}>
            {option.label}
          </button>
        ))}
      </nav>

      {tab === "appointments" && <AppointmentsTab />}
      {tab === "statement" && <StatementTab />}
      {tab === "intake" && <IntakeTab />}
      {tab === "messages" && <MessagesTab />}
    </main>
  );
}

function LoginScreen({ onLogin }: { onLogin: (session: { fullName: string; patientNumber: string }) => void }) {
  const [phone, setPhone] = useState("");
  const [patientNumber, setPatientNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, patientNumber }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الدخول.");
      onLogin(payload as { fullName: string; patientNumber: string });
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "تعذّر الدخول.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-4">
      <div className="mb-6 text-center">
        <Logo className="mx-auto mb-3 h-12 w-12" />
        <h1 className="text-xl font-black text-navy-900">بوابة المريض</h1>
        <p className="mt-1 text-sm text-slate-500">
          أدخل رقم هاتفك ورقم ملفك كما أُعطي لك من الاستقبال.
        </p>
      </div>
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-slate-700">رقم الهاتف</span>
          <input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} dir="ltr"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left" placeholder="777000000" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-slate-700">رقم الملف</span>
          <input type="text" value={patientNumber} onChange={(event) => setPatientNumber(event.target.value)} dir="ltr"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left" placeholder="P-0001" />
        </label>
        {error && <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">{error}</p>}
        <button onClick={submit} disabled={busy}
          className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-black text-white disabled:opacity-50">
          {busy ? "جارٍ الدخول…" : "دخول"}
        </button>
      </div>
    </main>
  );
}

function AppointmentsTab() {
  const [feed, setFeed] = useState<{ today: string; appointments: PortalAppointmentView[] } | null>(null);
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

  useEffect(() => { void load(); }, [load]);

  const confirm = async (id: number) => {
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

  if (error) return <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">{error}</p>;
  if (!feed) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;
  if (feed.appointments.length === 0) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">لا مواعيد قادمة في ملفك. لطلب موعد استخدم صفحة طلب الموعد أو اتصل بالاستقبال.</p>;
  }

  return (
    <section className="space-y-3">
      {feed.appointments.map((appointment) => (
        <article key={appointment.id} className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-black text-navy-900">{friendlyDate(appointment.scheduledDate)}</p>
              <p className="text-sm text-slate-600">الساعة {appointment.scheduledTime} · {appointment.durationMinutes} دقيقة</p>
              {appointment.appointmentType && <p className="text-xs text-slate-500">{appointment.appointmentType}</p>}
              {appointment.note && <p className="mt-1 text-xs text-slate-500">{appointment.note}</p>}
            </div>
            {appointment.patientConfirmedAt ? (
              <span className="rounded-lg bg-success-100 px-2 py-1 text-xs font-black text-success-800">مؤكد الحضور ✓</span>
            ) : appointment.confirmable ? (
              <button onClick={() => confirm(appointment.id)} disabled={busyId === appointment.id}
                className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-black text-white disabled:opacity-50">
                {busyId === appointment.id ? "…" : "أؤكد حضورى"}
              </button>
            ) : (
              <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">محدود بالتأكيد</span>
            )}
          </div>
        </article>
      ))}
    </section>
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

  if (error) return <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">{error}</p>;
  if (!feed) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;

  const due = feed.balance.dueMinor;
  return (
    <section className="space-y-4">
      <div className={`rounded-2xl border p-4 ${due > 0 ? "border-warning-300 bg-warning-50" : due < 0 ? "border-slate-200 bg-white" : "border-success-300 bg-success-50"}`}>
        <p className="text-xs font-bold text-slate-600">
          {due > 0 ? "المتبقي على حسابك" : due < 0 ? "رصيد لصالحك عندنا" : "الحساب مسدّد"}
        </p>
        <p className="mt-1 text-2xl font-black tabular-nums text-navy-900">
          {formatMoney(Math.abs(due), feed.baseCurrency)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          إجمالي الفواتير {formatMoney(feed.balance.billedMinor, feed.baseCurrency)} · المسدَّد
          {" "}{formatMoney(feed.balance.collectedMinor, feed.baseCurrency)}
          {feed.balance.openingMinor !== 0 && ` · رصيد سابق ${formatMoney(feed.balance.openingMinor, feed.baseCurrency)}`}
        </p>
      </div>

      {feed.opening && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
          <p className="font-bold text-slate-700">رصيد سابق على النظام (بقبل {feed.opening.asOfDate})</p>
          <p className="tabular-nums text-slate-600">{formatMoney(feed.opening.amountMinor, feed.baseCurrency)}</p>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-black text-navy-900">الفواتير</h2>
        {feed.invoices.length === 0 ? (
          <p className="text-sm text-slate-500">لا فواتير بعد.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {feed.invoices.map((invoice) => (
              <li key={invoice.invoiceNumber} className="flex items-center justify-between py-2 text-sm">
                <span className="font-bold">{invoice.invoiceNumber}</span>
                <span className="text-slate-500">{friendlyDate(invoice.createdAt.slice(0, 10))}</span>
                <span className="tabular-nums">{formatMoney(invoice.totalMinor, feed.baseCurrency)}</span>
                <span className={invoice.status === "cancelled" ? "text-danger-700" : "text-success-800"}>
                  {invoice.status === "cancelled" ? "ملغاة" : "معتمدة"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

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
                <span className="tabular-nums">
                  {payment.kind === "refund" ? "−" : ""}{formatMoney(payment.amountMinor, payment.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function IntakeTab() {
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
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/portal/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conditions, allergies, medications, emergencyName, emergencyPhone, note,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الإرسال.");
      setLatest({ createdAt: payload.createdAt, answers: { conditions, allergies, medications, emergencyName, emergencyPhone, note } });
      setSaved(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "تعذّر الإرسال.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      {latest && (
        <p className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-500">
          آخر استمارة مُرسلة: {friendlyDate(latest.createdAt.slice(0, 10))}. كل إرسال نسخة جديدة — الطاقم يقرأ الأحدث.
        </p>
      )}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-black text-navy-900">حالات مزمنة (أشِر ما ينطبق)</h2>
        <div className="flex flex-wrap gap-2">
          {INTAKE_CONDITIONS.map((condition) => {
            const active = conditions.includes(condition.key);
            return (
              <button key={condition.key}
                onClick={() => setConditions((list) => active ? list.filter((key) => key !== condition.key) : [...list, condition.key])}
                className={active
                  ? "rounded-full bg-navy-800 px-3 py-1.5 text-xs font-bold text-white"
                  : "rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600"}>
                {condition.label}
              </button>
            );
          })}
        </div>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-700">حساسية (أدوية، مواد)</span>
            <textarea value={allergies} onChange={(event) => setAllergies(event.target.value)} rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-700">أدوية تتناولها حاليًا</span>
            <textarea value={medications} onChange={(event) => setMedications(event.target.value)} rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-slate-700">جهة اتصال طارئة</span>
              <input type="text" value={emergencyName} onChange={(event) => setEmergencyName(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-slate-700">هاتف الطوارئ</span>
              <input type="tel" dir="ltr" value={emergencyPhone} onChange={(event) => setEmergencyPhone(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-700">ملاحظات للطبيب</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2" />
          </label>
        </div>
        {error && <p className="mt-3 rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">{error}</p>}
        {saved && <p className="mt-3 rounded-xl border border-success-200 bg-success-50 p-3 text-sm font-bold text-success-800">وصلت استمارتك — سيراها الطاقم قبل زيارتك القادمة.</p>}
        <button onClick={submit} disabled={busy}
          className="mt-4 w-full rounded-xl bg-navy-800 py-2.5 text-sm font-black text-white disabled:opacity-50">
          {busy ? "جارٍ الإرسال…" : "إرسال الاستمارة"}
        </button>
      </div>
    </section>
  );
}

/**
 * محادثة المريض مع العيادة — رسائل المريض تصل صندوق الطاقم كله، وردّهم يظهر هنا.
 *
 * رسائل المريض على يمين الشاشة (صفوفه) وردّ العيادة على يسارها باسم من ردّ —
 * فالمريض يعرف أن خلف الردّ إنسانًا بعينه لا روبوت. والتحديث كل عشر ثوانٍ ما
 * دام التبويب مفتوحًا، ونغمةٌ خفيفة عند ردٍّ جديد، والإرسال نصًا وصوتًا
 * ومرفقات (صور أشعة أو تقارير PDF).
 */
function MessagesTab() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastSeenIdRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/messages", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المحادثة.");
      const next: ChatMessage[] = payload.messages ?? [];
      const lastId = next.at(-1)?.id ?? null;
      const prevSeen = lastSeenIdRef.current;
      if (lastId !== null && prevSeen !== null && lastId > prevSeen) {
        const reply = next.find((message) => message.id > prevSeen && message.senderType === "user");
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

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = useCallback(async (payload: {
    body?: string; kind: "text" | "voice" | "file";
    voiceMime?: string; voiceData?: string; voiceMs?: number;
    fileName?: string; fileMime?: string; fileSize?: number; fileData?: string;
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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-[11px] font-black text-navy-800">
          عيادتك
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-navy-900">محادثة العيادة</p>
          <p className="text-[11px] font-semibold text-slate-400">
            رسالتك تصل إلى فريق العيادة كله — نصًا كانت أو تسجيلًا صوتيًا أو صورةً وتقريرًا.
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {loading && <p className="text-center text-sm text-slate-400">جارٍ التحميل…</p>}
        {error && (
          <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800" role="alert">
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
                <MessageBubble message={message} mine={message.senderType === "patient"} />
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
        <ChatComposer
          placeholder="اكتب رسالتك للعيادة…"
          onSendText={(body) => send({ body, kind: "text" })}
          onSendVoice={(voice) => send({
            kind: "voice",
            voiceMime: voice.mime,
            voiceData: voice.data,
            voiceMs: voice.ms,
          })}
          onSendFile={(file) => send({
            kind: "file",
            body: file.caption ?? undefined,
            fileName: file.name,
            fileMime: file.mime,
            fileSize: file.size,
            fileData: file.data,
          })}
        />
      </footer>
    </section>
  );
}
