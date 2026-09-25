"use client";

import { useMemo, useState } from "react";
import { CURRENCY_SHORT, formatMoney, type Currency } from "@/lib/money";
import { browserInflateRaw, readFirstSheet, rowsToCsv } from "@/lib/xlsx-reader";
import { LegacyImportSection } from "@/components/LegacyImportSection";

/**
 * (P1-5) استيراد مرضى المركز القديم من ملف Excel.
 *
 * ثلاث خطوات لا تُختصر: **اختر الملف ← عاين كل سطر ← استورد**. ولا يُكتب شيء قبل
 * الخطوة الثالثة. والمكرر المؤكد لا يُستورد أبدًا (الدمج قرار بشري بأداة الدمج)،
 * والمشتبه لا يُستورد إلا بعلامةٍ صريحة، والرصيد بغير الريال اليمني لا يُحوَّل.
 */

type Status = "new" | "duplicate" | "possible_duplicate" | "duplicate_in_file" | "invalid";

interface PreviewRow {
  line: number;
  status: Status;
  reason: string | null;
  fullName: string | null;
  phone: string | null;
  birthYear: number | null;
  legacyNumber: string | null;
  openingMinor: number | null;
  manualBalance: { amount: string; currency: Currency } | null;
  matchedPatient: { id: number; patientNumber: string; fullName: string } | null;
}

interface Preview {
  fileSha256: string;
  alreadyImported: { at: string; actor: string } | null;
  problems: string[];
  summary: Record<Status, number> & { manualBalances: number };
  rows: PreviewRow[];
}

interface CommitResult {
  created: { line: number; id: number; patientNumber: string; fullName: string }[];
  manualBalances: (PreviewRow & { patientId: number; patientNumber: string })[];
}

const STATUS_LABEL: Record<Status, string> = {
  new: "جديد — سيُستورد",
  possible_duplicate: "مشتبه — راجع",
  duplicate: "موجود — يُتخطّى",
  duplicate_in_file: "مكرر في الملف",
  invalid: "غير صالح",
};

const STATUS_TONE: Record<Status, string> = {
  new: "bg-emerald-50 text-emerald-800 border-emerald-200",
  possible_duplicate: "bg-amber-50 text-amber-800 border-amber-200",
  duplicate: "bg-slate-100 text-slate-600 border-slate-200",
  duplicate_in_file: "bg-slate-100 text-slate-600 border-slate-200",
  invalid: "bg-rose-50 text-rose-700 border-rose-200",
};

const TEMPLATE_HEADERS = [
  "الاسم", "الهاتف", "هاتف بديل", "الجنس", "سنة الميلاد", "تاريخ الميلاد", "العنوان",
  "تنبيه طبي", "ملاحظات", "رقم الملف", "الرصيد", "العملة", "ولي الأمر", "هاتف ولي الأمر", "المصدر",
];

function downloadTemplate() {
  const sample = ["محمد أحمد سالم", "777123456", "", "ذكر", "2008", "", "تعز", "", "", "1024", "15000", "ريال يمني", "", "", ""];
  const text = `\uFEFF${TEMPLATE_HEADERS.join(",")}\r\n${sample.join(",")}\r\n`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "نموذج-استيراد-المرضى.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/** (P1-5ج) ملف Excel (xlsx) أو CSV إلى نص CSV — القراءة في المتصفح، لا يخرج الملف كما هو. */
async function fileToCsv(file: File): Promise<string> {
  if (/\.xlsx$/i.test(file.name)) {
    const rows = await readFirstSheet(new Uint8Array(await file.arrayBuffer()), browserInflateRaw);
    return rowsToCsv(rows);
  }
  return file.text();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export default function PatientImportPage() {
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [includePossible, setIncludePossible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CommitResult | null>(null);

  const visibleRows = useMemo(
    () => (preview?.rows ?? []).filter((row) => filter === "all" || row.status === filter),
    [preview, filter],
  );
  const toImport = preview ? preview.summary.new + (includePossible ? preview.summary.possible_duplicate : 0) : 0;

  async function choose(file: File | undefined) {
    setPreview(null); setResult(null); setError(""); setFilter("all"); setIncludePossible(false);
    if (!file) return;
    if (/\.xls$/i.test(file.name)) {
      setError("صيغة Excel القديمة (xls) غير مقروءة — احفظ الملف بصيغة xlsx أو «CSV UTF-8» ثم اختره.");
      return;
    }
    let text: string;
    try {
      // (P1-5ج) ملف Excel يُقرأ كما هو — لا حاجة لتحويله يدويًّا.
      text = await fileToCsv(file);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "تعذّرت قراءة الملف.");
      return;
    }
    setFileName(file.name);
    setCsv(text);
    setBusy(true);
    try {
      const response = await fetch("/api/patients/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "preview", csv: text, fileName: file.name }),
      });
      const payload = await readJson(response);
      if (!response.ok) { setError(String(payload.message ?? "تعذّرت المعاينة.")); return; }
      setPreview(payload as unknown as Preview);
    } catch {
      setError("تعذّر الاتصال بالخادم. أعد المحاولة.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || toImport === 0) return;
    if (!window.confirm(`سيُنشأ ${toImport} ملف مريض جديد. متابعة؟`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/patients/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "commit", csv, fileName, fileSha256: preview.fileSha256, includePossibleDuplicates: includePossible,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) { setError(String(payload.message ?? "تعذّر الاستيراد.")); return; }
      setResult(payload as unknown as CommitResult);
      setPreview(null);
    } catch {
      setError("انقطع الاتصال أثناء الاستيراد. عاين الملف من جديد: إن كان قد حُفظ فسيظهر أنه استُورد.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">استيراد مرضى المركز القديم</h1>
        <p className="text-xs text-slate-500">من ملف Excel محفوظ بصيغة CSV — معاينة كاملة قبل أي حفظ</p>
        <div className="mt-2">
          <a href="/settings" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الإعدادات</a>
        </div>
      </header>

      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="اختيار الملف">
        <ol className="mb-3 list-decimal space-y-1 pr-5 text-[12px] font-bold leading-6 text-slate-600">
          <li>اختر ملف Excel (xlsx) كما هو، أو ملف «CSV UTF-8».</li>
          <li>السطر الأول عناوين الأعمدة. عمود «الاسم» لازم، والبقية اختيارية.</li>
          <li>«الرصيد» بالريال اليمني يُستورد رصيدًا افتتاحيًّا؛ وبعملةٍ أخرى يُسجَّل المريض وتُعطى قائمة لإدخال رصيده يدويًّا.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-xl bg-navy-800 px-4 py-2 text-sm font-extrabold text-white">
            اختر الملف
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" disabled={busy}
              onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
          <button type="button" onClick={downloadTemplate}
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-800">
            نزّل نموذج الأعمدة
          </button>
          {fileName ? <span className="text-xs font-bold text-slate-500">{fileName}</span> : null}
          {busy ? <span className="text-xs font-bold text-slate-500">جارٍ…</span> : null}
        </div>
        {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-2 text-xs font-bold text-rose-700">{error}</p> : null}
      </section>

      {preview ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="المعاينة">
          {preview.alreadyImported ? (
            <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-2 text-xs font-bold text-rose-700">
              هذا الملف استُورد من قبل ({new Date(preview.alreadyImported.at).toLocaleString("ar")} — {preview.alreadyImported.actor}). لن يُستورد مرتين.
            </p>
          ) : null}
          {preview.problems.map((problem) => (
            <p key={problem} className="mb-2 rounded-xl bg-amber-50 p-2 text-xs font-bold text-amber-800">{problem}</p>
          ))}

          <div className="mb-3 flex flex-wrap gap-2 text-xs font-bold">
            <button type="button" onClick={() => setFilter("all")}
              className={`rounded-full border px-3 py-1 ${filter === "all" ? "bg-navy-800 text-white" : "bg-white text-slate-700"}`}>
              الكل ({preview.rows.length})
            </button>
            {(Object.keys(STATUS_LABEL) as Status[]).map((status) => (
              <button key={status} type="button" onClick={() => setFilter(status)}
                className={`rounded-full border px-3 py-1 ${filter === status ? "ring-2 ring-navy-800" : ""} ${STATUS_TONE[status]}`}>
                {STATUS_LABEL[status]} ({preview.summary[status]})
              </button>
            ))}
          </div>
          {preview.summary.manualBalances > 0 ? (
            <p className="mb-3 text-[11px] font-bold text-slate-500">
              {preview.summary.manualBalances} رصيدًا بعملةٍ غير الريال اليمني — لن تُحوَّل، وستظهر قائمتها بعد الاستيراد لإدخالها يدويًّا.
            </p>
          ) : null}

          <div className="max-h-[55vh] overflow-auto rounded-xl border border-slate-100">
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-2">السطر</th><th className="p-2">الحالة</th><th className="p-2">الاسم</th>
                  <th className="p-2">الهاتف</th><th className="p-2">الرصيد</th><th className="p-2">ملاحظة</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.slice(0, 500).map((row) => (
                  <tr key={row.line} className="border-t border-slate-100">
                    <td className="p-2 tabular-nums">{row.line}</td>
                    <td className="p-2"><span className={`rounded-full border px-2 py-0.5 ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span></td>
                    <td className="p-2 font-bold">{row.fullName ?? "—"}</td>
                    <td className="p-2 tabular-nums" dir="ltr">{row.phone ?? ""}</td>
                    <td className="p-2 tabular-nums">
                      {row.openingMinor ? formatMoney(row.openingMinor, "YER") : row.manualBalance
                        ? `${row.manualBalance.amount} ${CURRENCY_SHORT[row.manualBalance.currency]} (يدوي)` : ""}
                    </td>
                    <td className="p-2 text-slate-500">
                      {row.reason ?? ""}
                      {row.matchedPatient ? (
                        <a className="mr-1 font-bold text-navy-800 underline" href={`/patients/${row.matchedPatient.id}`} target="_blank" rel="noreferrer">
                          {row.matchedPatient.fullName}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRows.length > 500 ? (
              <p className="p-2 text-center text-[11px] font-bold text-slate-400">تُعرض أول ٥٠٠ سطر — صفِّ بالحالة لرؤية البقية.</p>
            ) : null}
          </div>

          {preview.summary.possible_duplicate > 0 ? (
            <label className="mt-3 flex items-center gap-2 text-xs font-bold text-amber-800">
              <input type="checkbox" checked={includePossible} onChange={(event) => setIncludePossible(event.target.checked)} />
              استورد المشتبهين أيضًا ({preview.summary.possible_duplicate}) — راجعتهم وهم أشخاص مختلفون
            </label>
          ) : null}
          <button type="button" disabled={busy || toImport === 0 || Boolean(preview.alreadyImported)} onClick={() => void commit()}
            className="mt-3 w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
            استورد {toImport} مريضًا
          </button>
        </section>
      ) : null}

      {result ? (
        <section className="rounded-2xl border-2 border-emerald-600/40 bg-emerald-50/60 p-4" aria-label="نتيجة الاستيراد">
          <p className="text-sm font-extrabold text-emerald-900">تم استيراد {result.created.length} مريضًا.</p>
          {result.manualBalances.length > 0 ? (
            <div className="mt-3">
              <p className="mb-2 text-xs font-extrabold text-amber-800">
                أرصدة بعملةٍ غير الريال اليمني — أدخلها يدويًّا من ملف كل مريض:
              </p>
              <ul className="space-y-1 text-xs font-bold">
                {result.manualBalances.map((row) => (
                  <li key={row.line}>
                    <a className="text-navy-800 underline" href={`/patients/${row.patientId}`} target="_blank" rel="noreferrer">
                      {row.patientNumber} — {row.fullName}
                    </a>
                    : {row.manualBalance?.amount} {row.manualBalance ? CURRENCY_SHORT[row.manualBalance.currency] : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      {/* (P1-5ج) بعد المرضى: معالجاتهم ودفعاتهم من النظام القديم. */}
      <LegacyImportSection />
    </main>
  );
}
