"use client";

import { useState } from "react";
import { formatMoney, type Currency } from "@/lib/money";
import { browserInflateRaw, readFirstSheet, rowsToCsv } from "@/lib/xlsx-reader";

/**
 * (P1-5ج) استيراد معالجات النظام القديم ودفعاته — بعد استيراد المرضى.
 *
 * يُختار ملفّا «المعالجات» و«الجلسات» كما صدّرهما النظام القديم (Excel). المعاينة تعرض
 * كم ارتبط بمرضاه تلقائيًّا، وتطلب من المالك صاحب كل معالجةٍ لم تُربط (اسمٌ مكرر بلا
 * هاتف يفرّقه، أو اسمٌ غير موجود). ثم الحفظ: أرشيفٌ للقراءة في ملف كل مريض، والباقي
 * رصيدٌ افتتاحي **بعملته** (لا تحويل).
 */

interface Unresolved {
  legacyNumber: number; patientName: string; phone: string | null; treatedOn: string | null; service: string | null;
  currency: Currency; remainingMinor: number;
  candidates: { id: number; patientNumber: string; fullName: string; phone: string | null }[];
}

interface Preview {
  fileSha256: string;
  alreadyImported: { at: string; actor: string } | null;
  problems: { line: number; reason: string; file: string }[];
  summary: {
    treatments: number; treatmentsMatched: number; treatmentsAmbiguous: number; treatmentsUnmatched: number;
    sessions: number; sessionsMatched: number; sessionsUnmatched: number;
    balancesByCurrency: Partial<Record<Currency, number>>;
  };
  unresolved: Unresolved[];
  conflicts: number;
}

async function toCsv(file: File): Promise<string> {
  if (/\.xlsx$/i.test(file.name)) return rowsToCsv(await readFirstSheet(new Uint8Array(await file.arrayBuffer()), browserInflateRaw));
  return file.text();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export function LegacyImportSection() {
  const [treatments, setTreatments] = useState<{ name: string; csv: string } | null>(null);
  const [sessions, setSessions] = useState<{ name: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [assignments, setAssignments] = useState<Record<number, number>>({});
  const [lookup, setLookup] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ treatments: number; sessions: number; skippedTreatments: number; conflicts: unknown[]; balances: { currency: Currency; amountMinor: number }[] } | null>(null);

  async function pick(kind: "treatments" | "sessions", file: File | undefined) {
    setPreview(null); setDone(null); setError("");
    if (!file) return;
    try {
      const value = { name: file.name, csv: await toCsv(file) };
      if (kind === "treatments") setTreatments(value); else setSessions(value);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "تعذّرت قراءة الملف.");
    }
  }

  async function send(mode: "preview" | "commit", nextAssignments = assignments) {
    if (!treatments) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/patients/import/legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode, treatmentsCsv: treatments.csv, sessionsCsv: sessions?.csv ?? "",
          fileNames: [treatments.name, sessions?.name].filter(Boolean).join("، "),
          assignments: nextAssignments, fileSha256: preview?.fileSha256,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) { setError(String(payload.message ?? "تعذّر الطلب.")); return; }
      if (mode === "preview") setPreview(payload as unknown as Preview);
      else { setDone(payload as unknown as NonNullable<typeof done>); setPreview(null); }
    } catch {
      setError("تعذّر الاتصال بالخادم. أعد المحاولة.");
    } finally {
      setBusy(false);
    }
  }

  async function findPatient(legacyNumber: number) {
    const term = (lookup[legacyNumber] ?? "").trim();
    if (!term) return;
    const response = await fetch(`/api/patients?q=${encodeURIComponent(term)}`, { cache: "no-store" });
    const rows = (await readJson(response)) as unknown;
    const list = Array.isArray(rows) ? rows as { id: number; patientNumber: string; fullName: string }[] : [];
    if (list.length === 1) {
      const next = { ...assignments, [legacyNumber]: list[0].id };
      setAssignments(next);
      await send("preview", next);
    } else {
      setError(list.length === 0 ? `لا مريض يطابق «${term}».` : `«${term}» يطابق ${list.length} مرضى — اكتب رقم الملف.`);
    }
  }

  const balances = preview ? (Object.entries(preview.summary.balancesByCurrency) as [Currency, number][]) : [];

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4" aria-label="معالجات ودفعات النظام القديم">
      <h2 className="text-sm font-extrabold">معالجات ودفعات النظام القديم</h2>
      <p className="mb-3 mt-1 text-[11px] font-bold leading-5 text-slate-500">
        بعد استيراد المرضى: اختر ملف «المعالجات» وملف «الجلسات» كما صدّرهما النظام القديم. تُحفظ المعالجات والدفعات
        في ملف كل مريض للاطلاع، ولا تدخل الصندوق. وما بقي على كل مريض يصير رصيدًا افتتاحيًّا <b>بعملته</b> —
        السعودي سعودي والدولار دولار.
      </p>
      <div className="flex flex-wrap gap-2">
        <label className="cursor-pointer rounded-xl bg-navy-800 px-3 py-2 text-xs font-extrabold text-white">
          ملف المعالجات {treatments ? `✓ ${treatments.name}` : ""}
          <input type="file" accept=".xlsx,.csv" className="hidden" disabled={busy}
            onChange={(event) => { void pick("treatments", event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <label className="cursor-pointer rounded-xl border border-navy-800 px-3 py-2 text-xs font-extrabold text-navy-800">
          ملف الجلسات (الدفعات) {sessions ? `✓ ${sessions.name}` : ""}
          <input type="file" accept=".xlsx,.csv" className="hidden" disabled={busy}
            onChange={(event) => { void pick("sessions", event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <button type="button" disabled={busy || !treatments} onClick={() => void send("preview")}
          className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-40">
          {busy ? "جارٍ…" : "عاين"}
        </button>
      </div>
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-2 text-xs font-bold text-rose-700">{error}</p> : null}

      {preview ? (
        <div className="mt-4 space-y-3 text-xs font-bold">
          {preview.alreadyImported ? (
            <p role="alert" className="rounded-xl bg-rose-50 p-2 text-rose-700">هذان الملفان استُوردا من قبل — لا يُستوردان مرتين.</p>
          ) : null}
          <p>
            المعالجات: {preview.summary.treatmentsMatched} من {preview.summary.treatments} مرتبطة بمرضاها ·
            الدفعات: {preview.summary.sessionsMatched} من {preview.summary.sessions}
          </p>
          <p>
            الأرصدة الافتتاحية الناتجة:{" "}
            {balances.length ? balances.map(([currency, minor]) => formatMoney(minor, currency)).join(" · ") : "لا شيء"}
            {preview.conflicts > 0 ? ` — ${preview.conflicts} رصيدًا يتعارض مع رصيدٍ مسجّل سلفًا ولن يُكتب فوقه` : ""}
          </p>
          {preview.problems.length > 0 ? (
            <p className="text-amber-800">أسطر لم تُقرأ: {preview.problems.slice(0, 5).map((p) => `${p.file} ${p.line}: ${p.reason}`).join(" · ")}</p>
          ) : null}

          {preview.unresolved.length > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="mb-2 text-amber-900">معالجات تحتاج أن تختار صاحبها ({preview.unresolved.length}) — ما لا تختاره يُترك:</p>
              <ul className="space-y-2">
                {preview.unresolved.map((row) => (
                  <li key={row.legacyNumber} className="flex flex-wrap items-center gap-2">
                    <span>#{row.legacyNumber} · {row.patientName} · {row.service ?? ""} · {row.treatedOn ?? ""} · باقي {formatMoney(row.remainingMinor, row.currency)}</span>
                    {row.candidates.length > 0 ? (
                      <select value={assignments[row.legacyNumber] ?? ""} aria-label={`صاحب المعالجة ${row.legacyNumber}`}
                        onChange={(event) => {
                          const next = { ...assignments };
                          if (event.target.value) next[row.legacyNumber] = Number(event.target.value); else delete next[row.legacyNumber];
                          setAssignments(next);
                          void send("preview", next);
                        }}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1">
                        <option value="">— اختر —</option>
                        {row.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.patientNumber} · {candidate.fullName}{candidate.phone ? ` · ${candidate.phone}` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="flex items-center gap-1">
                        <input value={lookup[row.legacyNumber] ?? ""} placeholder="رقم الملف أو الاسم"
                          onChange={(event) => setLookup({ ...lookup, [row.legacyNumber]: event.target.value })}
                          className="w-36 rounded-lg border border-slate-300 px-2 py-1" />
                        <button type="button" onClick={() => void findPatient(row.legacyNumber)}
                          className="rounded-lg border border-slate-300 px-2 py-1">اربط</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <button type="button" disabled={busy || Boolean(preview.alreadyImported)}
            onClick={() => {
              if (window.confirm("تُحفظ المعالجات والدفعات المرتبطة، وتُثبت الأرصدة بعملاتها. متابعة؟")) void send("commit");
            }}
            className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
            استورد المعالجات والدفعات
          </button>
        </div>
      ) : null}

      {done ? (
        <div className="mt-4 rounded-xl border-2 border-emerald-600/40 bg-emerald-50/60 p-3 text-xs font-bold text-emerald-900">
          <p>تم: {done.treatments} معالجة و{done.sessions} دفعة{done.skippedTreatments ? ` — تُركت ${done.skippedTreatments} معالجة بلا صاحب` : ""}.</p>
          <p className="mt-1">
            الأرصدة المُثبتة:{" "}
            {Object.entries(done.balances.reduce<Record<string, number>>((sum, row) => ({ ...sum, [row.currency]: (sum[row.currency] ?? 0) + row.amountMinor }), {}))
              .map(([currency, minor]) => `${formatMoney(minor, currency as Currency)}`).join(" · ") || "لا شيء"}
            {done.conflicts.length ? ` — ${done.conflicts.length} تعارضًا لم يُكتب (للمريض رصيدٌ مسجّل بالعملة نفسها)` : ""}
          </p>
          <p className="mt-1 text-slate-500">تجدها في ملف كل مريض ← «الحساب» ← «سجل النظام القديم».</p>
        </div>
      ) : null}
    </section>
  );
}
