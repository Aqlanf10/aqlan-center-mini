"use client";

import { useEffect, useState } from "react";
import { CHANNEL_LABEL, SECRET_LABEL, type Channel } from "@/lib/messaging-channels";

/**
 * (MSG-1) إعدادات قنوات الرسائل — طلب المالك: «لكل وحدةٍ إعداداتها لأتحكم برقم الواتس
 * ورقم الرسائل والبريد». بطاقةٌ لكل قناة: التفعيل، الإعدادات، السرّ (يُكتب ولا يُعرض)، واختبار.
 */

interface ChannelView {
  channel: Channel;
  enabled: boolean;
  config: Record<string, string | number>;
  hasSecret: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

type Field = { key: string; label: string; hint?: string; type?: "text" | "number" | "select"; options?: [string, string][]; ltr?: boolean };

const FIELDS: Record<Channel, Field[]> = {
  whatsapp: [
    { key: "displayNumber", label: "رقم واتساب المركز (كما يراه المرضى)", hint: "مثال: 967770000000", ltr: true },
    { key: "phoneNumberId", label: "معرّف رقم الهاتف لدى Meta (Phone number ID)", ltr: true },
    { key: "graphVersion", label: "إصدار الواجهة", hint: "v21.0", ltr: true },
  ],
  sms: [
    { key: "url", label: "عنوان بوابة الرسائل (https://…)", ltr: true },
    { key: "method", label: "الطريقة", type: "select", options: [["POST", "POST"], ["GET", "GET"]] },
    { key: "bodyFormat", label: "صيغة الجسم (POST)", type: "select", options: [["form", "نموذج form"], ["json", "JSON"]] },
    { key: "sender", label: "اسم/رقم المرسل الظاهر للمريض", hint: "المسجّل لدى البوابة" },
    { key: "username", label: "اسم المستخدم لدى البوابة", ltr: true },
    { key: "numberFormat", label: "صيغة رقم المستلم", type: "select", options: [["international", "دولي 967…"], ["local", "محلي 7…"]] },
    { key: "toParam", label: "اسم حقل الرقم", ltr: true },
    { key: "textParam", label: "اسم حقل النص", ltr: true },
    { key: "senderParam", label: "اسم حقل المرسل", ltr: true },
    { key: "userParam", label: "اسم حقل المستخدم", ltr: true },
    { key: "keyParam", label: "اسم حقل المفتاح", ltr: true },
    { key: "successPattern", label: "نصٌّ في ردّ البوابة يدل على النجاح (اختياري)", ltr: true },
  ],
  email: [
    { key: "host", label: "خادم البريد (SMTP)", hint: "مثال: smtp.gmail.com", ltr: true },
    { key: "port", label: "المنفذ", type: "number", hint: "587 أو 465" },
    { key: "security", label: "التشفير", type: "select", options: [["starttls", "STARTTLS (587)"], ["tls", "TLS مباشر (465)"]] },
    { key: "username", label: "اسم المستخدم", ltr: true },
    { key: "fromAddress", label: "عنوان المرسل", ltr: true },
    { key: "fromName", label: "اسم المرسل", hint: "اسم المركز" },
  ],
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function ChannelCard({ initial, onSaved }: { initial: ChannelView; onSaved: (view: ChannelView) => void }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [config, setConfig] = useState<Record<string, string | number>>(initial.config);
  const [secret, setSecret] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(removeSecret = false) {
    setBusy(true); setNote(null);
    try {
      const response = await fetch("/api/settings/messaging", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: initial.channel, enabled, config, ...(secret ? { secret } : {}), ...(removeSecret ? { removeSecret: true } : {}) }),
      });
      const payload = await readJson(response);
      if (!response.ok) { setNote({ ok: false, text: String(payload.message ?? "تعذّر الحفظ.") }); return; }
      setSecret("");
      onSaved(payload.channel as ChannelView);
      setNote({ ok: true, text: "حُفظت الإعدادات." });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true); setNote(null);
    try {
      const response = await fetch("/api/settings/messaging/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: initial.channel, to: testTo }),
      });
      const payload = await readJson(response);
      setNote(response.ok ? { ok: true, text: "أُرسلت رسالة الاختبار." } : { ok: false, text: String(payload.message ?? "فشل الاختبار.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label={CHANNEL_LABEL[initial.channel]}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-extrabold text-navy-900">{CHANNEL_LABEL[initial.channel]}</h2>
        <label className="flex items-center gap-2 text-xs font-bold">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          مفعّلة
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS[initial.channel].map((field) => (
          <label key={field.key} className="block text-[11px] font-bold text-slate-600">
            {field.label}
            {field.type === "select" ? (
              <select value={String(config[field.key] ?? "")} onChange={(event) => setConfig({ ...config, [field.key]: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm">
                {(field.options ?? []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            ) : (
              <input value={String(config[field.key] ?? "")} dir={field.ltr ? "ltr" : undefined} placeholder={field.hint}
                inputMode={field.type === "number" ? "numeric" : undefined}
                onChange={(event) => setConfig({ ...config, [field.key]: field.type === "number" ? Number(event.target.value) || "" : event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
            )}
          </label>
        ))}
        <label className="block text-[11px] font-bold text-slate-600 sm:col-span-2">
          {SECRET_LABEL[initial.channel]} — {initial.hasSecret ? "مضبوط ✓ (اكتب قيمة جديدة لاستبداله)" : "غير مضبوط"}
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" dir="ltr"
            className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void save()}
          className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-extrabold text-white disabled:opacity-40">حفظ</button>
        {initial.hasSecret ? (
          <button type="button" disabled={busy} onClick={() => { if (window.confirm("حذف السرّ المحفوظ لهذه القناة؟")) void save(true); }}
            className="rounded-xl border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 disabled:opacity-40">حذف السرّ</button>
        ) : null}
        <input value={testTo} onChange={(event) => setTestTo(event.target.value)} dir="ltr"
          placeholder={initial.channel === "email" ? "بريد للاختبار" : "رقم جوال للاختبار"}
          className="min-w-40 flex-1 rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
        <button type="button" disabled={busy || !testTo.trim()} onClick={() => void test()}
          className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-40">إرسال اختبار</button>
      </div>
      {note ? <p role={note.ok ? "status" : "alert"} className={`mt-2 text-xs font-bold ${note.ok ? "text-emerald-700" : "text-rose-700"}`}>{note.text}</p> : null}
      {initial.lastTestAt ? (
        <p className="mt-1 text-[11px] text-slate-500">
          آخر اختبار: {new Date(initial.lastTestAt).toLocaleString("ar-YE-u-nu-latn")} — {initial.lastTestOk ? "نجح" : `فشل: ${initial.lastTestMessage ?? ""}`}
        </p>
      ) : null}
    </section>
  );
}

export default function MessagingSettingsPage() {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/settings/messaging", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) { setError(String(payload.message ?? "تعذّر التحميل.")); return; }
      setChannels(payload.channels as ChannelView[]);
    })();
  }, []);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
      <header>
        <h1 className="text-xl font-extrabold text-navy-900">قنوات الرسائل</h1>
        <p className="text-xs text-slate-500">
          واتساب للأعمال والرسائل النصية والبريد — لكل قناةٍ رقمها أو عنوانها وسرّها. السرّ يُحفظ مشفّرًا ولا يظهر بعد الحفظ.
          والرسائل الداخلية بين الطاقم تبقى كما هي في صفحة الرسائل.
        </p>
        <div className="mt-2">
          <a href="/settings" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الإعدادات</a>
        </div>
      </header>
      {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</p> : null}
      {channels ? channels.map((channel) => (
        <ChannelCard key={`${channel.channel}-${channel.hasSecret}-${channel.lastTestAt}`} initial={channel}
          onSaved={(saved) => setChannels((current) => (current ?? []).map((row) => (row.channel === saved.channel ? saved : row)))} />
      )) : !error ? <p className="text-sm text-slate-500">جارٍ التحميل…</p> : null}
    </main>
  );
}
