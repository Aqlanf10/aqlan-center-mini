"use client";

import { useEffect, useState } from "react";
import { ASSISTANT_MODE_KEYS } from "@/lib/assistant-modes";

const entries = [
  { key: ASSISTANT_MODE_KEYS[0], title: "المساعد الداخلي", detail: "يفتح الملفات المصرّح بها، ويعرض معلومات البرنامج ويجهّز الحجز للتأكيد." },
  { key: ASSISTANT_MODE_KEYS[1], title: "المساعد الخارجي", detail: "يستخدم المزوّد المفعّل للصياغة. عند إيقاف الداخلي يقبل قوالب إدارية عامة فقط." },
] as const;

type ModeKey = typeof ASSISTANT_MODE_KEYS[number];
type Snapshot = { values: Record<ModeKey, boolean>; versions: Partial<Record<ModeKey, string | null>> };

async function readSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch("/api/settings", { cache: "no-store", signal });
  if (!response.ok) throw new Error("تعذّر قراءة إعدادات تشغيل المساعد.");
  const data = await response.json();
  const [internal, external] = ASSISTANT_MODE_KEYS;
  if (![data[internal], data[external]].every(value => value === "true" || value === "false")) {
    throw new Error("إعدادات تشغيل المساعد غير متاحة.");
  }
  return { values: { [internal]: data[internal] === "true", [external]: data[external] === "true" }, versions: data.__versions ?? {} };
}

export function AssistantModeControls() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<ModeKey | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    readSnapshot(controller.signal).then(value => {
      if (!controller.signal.aborted) setSnapshot(value);
    }).catch(() => {
      if (!controller.signal.aborted) setError("تعذّر تحميل إعدادات تشغيل المساعد.");
    });
    return () => controller.abort();
  }, [generation]);

  async function change(key: ModeKey) {
    if (!snapshot || busy) return;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: String(!snapshot.values[key]), __versions: { [key]: snapshot.versions[key] ?? null } }),
      });
      if (response.status === 409) {
        setSnapshot(await readSnapshot());
        setError("تغيّرت القيمة في جلسة أخرى. راجع الحالة الحالية قبل المحاولة مجددًا.");
        return;
      }
      if (!response.ok) throw new Error("تعذّر حفظ إعداد المساعد.");
      setSnapshot(await readSnapshot());
      setMessage("حُفظ إعداد المساعد.");
    } catch {
      setSnapshot(null);
      setError("تعذّر تأكيد الحالة الحالية. أعد التحميل قبل أي تغيير آخر.");
    } finally {
      setBusy(null);
    }
  }

  return <section dir="rtl" aria-labelledby="assistant-mode-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
    <h2 className="mb-1 text-base font-black" id="assistant-mode-heading">تشغيل المساعد الذكي</h2>
    <p className="mb-4 text-sm text-slate-600">تحكّم في كل مساعد بشكل مستقل. فحص اتصال المزوّد يبقى متاحًا للمدير.</p>
    <div className="grid gap-3 md:grid-cols-2">
      {entries.map(entry => <div key={entry.key} className="rounded-xl border border-slate-200 px-4 py-3">
        <h3 className="font-bold">{entry.title}</h3>
        <p className="my-2 text-sm text-slate-600">{entry.detail}</p>
        <button type="button" role="switch" aria-label={entry.title} aria-checked={snapshot?.values[entry.key] ?? false}
          disabled={!snapshot || busy !== null} onClick={() => void change(entry.key)}
          className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue disabled:opacity-60">
          {busy === entry.key ? "جارٍ الحفظ…" : snapshot ? snapshot.values[entry.key] ? "مفعّل" : "متوقف" : "الحالة غير متاحة"}
        </button>
      </div>)}
    </div>
    {message && <p role="status" className="mt-3 text-sm font-bold text-emerald-800">{message}</p>}
    {error && <div className="mt-3 flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-rose-800">{error}</p>
      {!snapshot && <button type="button" className="text-sm underline" onClick={() => { setError(""); setGeneration(value => value + 1); }}>إعادة التحميل</button>}
    </div>}
  </section>;
}
