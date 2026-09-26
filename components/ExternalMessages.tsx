"use client";

import { useCallback, useEffect, useState } from "react";
import { CHANNEL_LABEL, type Channel } from "@/lib/messaging-channels";

/**
 * (MSG-1) رسائل المرضى عبر القنوات الخارجية — واتساب، الرسائل النصية، البريد: كتابةٌ
 * وإرسال، وسجلٌّ بكل ما خرج (ودخل لاحقًا) وحالته. القناة غير المهيّأة تقول ذلك صراحةً.
 */

interface Delivery {
  id: number;
  channel: Channel;
  direction: "out" | "in";
  patientId: number | null;
  patientName: string | null;
  counterpart: string;
  subject: string | null;
  body: string;
  purpose: string;
  status: "sent" | "failed" | "received";
  error: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface PatientHit { id: number; fullName: string; patientNumber: string; phone: string | null }

const STATUS_LABEL: Record<Delivery["status"], string> = { sent: "أُرسلت", failed: "فشلت", received: "وصلت" };
const PURPOSE_LABEL: Record<string, string> = { manual: "يدوية", reminder: "تذكير آلي", test: "اختبار", reply: "رد", inbound: "واردة", app: "من تطبيق الجوال" };

export function ExternalMessages() {
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [log, setLog] = useState<Delivery[]>([]);

  const loadLog = useCallback(async () => {
    const params = new URLSearchParams();
    if (patient) params.set("patientId", String(patient.id));
    const response = await fetch(`/api/messages/outbound?${params}`, { cache: "no-store" });
    if (response.ok) setLog(((await response.json()) as { rows: Delivery[] }).rows);
  }, [patient]);

  useEffect(() => { void loadLog(); }, [loadLog]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setHits([]); return; }
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/patients?q=${encodeURIComponent(term)}`, { cache: "no-store" });
      if (response.ok) setHits(((await response.json()) as PatientHit[]).slice(0, 8));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  /** الرد على رسالةٍ واردة: القناة نفسها والرقم نفسه والمريض إن عُرف. */
  function reply(item: Delivery) {
    setChannel(item.channel);
    setTo(item.counterpart);
    setPatient(item.patientId
      ? { id: item.patientId, fullName: item.patientName ?? "", patientNumber: "", phone: item.counterpart }
      : null);
    setReplying(true);
    setNote(null);
  }

  async function send() {
    setBusy(true); setNote(null);
    try {
      const response = await fetch("/api/messages/outbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, patientId: patient?.id ?? null, to, subject, body, purpose: replying ? "reply" : "manual" }),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.ok) {
        setNote({ ok: true, text: "أُرسلت الرسالة." });
        setBody("");
        setReplying(false);
      } else {
        setNote({ ok: false, text: payload.message ?? "تعذّر الإرسال." });
      }
      await loadLog();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="رسالة جديدة">
        <h2 className="mb-3 text-sm font-extrabold text-navy-900">رسالة لمريض</h2>
        <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
          {(["whatsapp", "sms", "email"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setChannel(value)}
              className={`rounded-lg py-1.5 text-xs font-black ${channel === value ? "bg-white text-navy-900 shadow-xs" : "text-slate-500"}`}>
              {CHANNEL_LABEL[value]}
            </button>
          ))}
        </div>
        <label className="block text-[11px] font-bold text-slate-600">
          المريض (اختياري)
          {patient ? (
            <span className="mt-1 flex items-center justify-between rounded-xl border border-slate-200 px-2 py-1.5 text-sm">
              {patient.fullName} — {patient.patientNumber}
              <button type="button" className="text-xs text-rose-700" onClick={() => { setPatient(null); setTo(""); setReplying(false); }}>إزالة</button>
            </span>
          ) : (
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث بالاسم أو الرقم"
              className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
          )}
        </label>
        {!patient && hits.length > 0 ? (
          <ul className="mt-1 max-h-40 overflow-auto rounded-xl border border-slate-200 text-sm">
            {hits.map((hit) => (
              <li key={hit.id}>
                <button type="button" className="w-full px-2 py-1 text-right hover:bg-slate-50"
                  onClick={() => { setPatient(hit); setQuery(""); setHits([]); if (channel !== "email") setTo(hit.phone ?? ""); }}>
                  {hit.fullName} — {hit.patientNumber}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="mt-2 block text-[11px] font-bold text-slate-600">
          {channel === "email" ? "البريد" : "رقم الجوال"}
          <input value={to} onChange={(event) => setTo(event.target.value)} dir="ltr"
            placeholder={channel === "email" ? "name@example.com" : "77xxxxxxx"}
            className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
        </label>
        {channel === "email" ? (
          <label className="mt-2 block text-[11px] font-bold text-slate-600">
            العنوان
            <input value={subject} onChange={(event) => setSubject(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
        ) : null}
        <label className="mt-2 block text-[11px] font-bold text-slate-600">
          النص
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} maxLength={4000}
            className="mt-1 w-full rounded-xl border border-slate-300 px-2 py-1.5 text-sm" />
        </label>
        {channel === "whatsapp" ? (
          <p className="mt-1 text-[11px] text-slate-500">
            واتساب يقبل الرسالة الحرّة خلال ٢٤ ساعة من آخر رسالةٍ من المريض؛ وخارجها تُستعمل القوالب المعتمدة (كالتذكير الآلي).
          </p>
        ) : null}
        <button type="button" disabled={busy || !body.trim() || (!to.trim() && !patient)} onClick={() => void send()}
          className="mt-3 w-full rounded-xl bg-emerald-600 py-2 text-sm font-extrabold text-white disabled:opacity-40">
          {busy ? "جارٍ الإرسال…" : `إرسال عبر ${CHANNEL_LABEL[channel]}`}
        </button>
        {note ? <p role={note.ok ? "status" : "alert"} className={`mt-2 text-xs font-bold ${note.ok ? "text-emerald-700" : "text-rose-700"}`}>{note.text}</p> : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="سجل الرسائل">
        <h2 className="mb-3 text-sm font-extrabold text-navy-900">
          سجل الرسائل {patient ? `— ${patient.fullName}` : ""}
        </h2>
        {log.length === 0 ? <p className="text-sm text-slate-500">لا رسائل بعد.</p> : (
          <ul className="max-h-[60vh] space-y-2 overflow-auto">
            {log.map((item) => (
              <li key={item.id} className={`rounded-xl border p-2 text-xs ${item.direction === "in" ? "border-sky-200 bg-sky-50" : "border-slate-200"}`}>
                <div className="flex flex-wrap items-center justify-between gap-1 font-bold text-slate-600">
                  <span>{CHANNEL_LABEL[item.channel]} · {item.direction === "in" ? "واردة من" : "إلى"} <span dir="ltr">{item.counterpart}</span>{item.patientName ? ` · ${item.patientName}` : ""}</span>
                  <span className={item.status === "failed" ? "text-rose-700" : "text-emerald-700"}>
                    {STATUS_LABEL[item.status]} · {PURPOSE_LABEL[item.purpose] ?? item.purpose}
                  </span>
                </div>
                {item.subject ? <p className="mt-1 font-bold">{item.subject}</p> : null}
                <p className="mt-1 whitespace-pre-wrap text-slate-800">{item.body}</p>
                {item.error ? <p className="mt-1 text-rose-700">{item.error}</p> : null}
                {item.direction === "in" ? (
                  <button type="button" className="mt-1 rounded-lg border border-sky-300 bg-white px-2 py-0.5 font-bold text-sky-800"
                    onClick={() => reply(item)}>
                    رد
                  </button>
                ) : null}
                <p className="mt-1 text-[10px] text-slate-400">{new Date(item.createdAt).toLocaleString("ar-YE-u-nu-latn")}{item.createdBy ? ` · ${item.createdBy}` : ""}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
