"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GENDER_LABEL, type Gender } from "@/lib/patient";
import { MATCH_LABEL, type DuplicateMatch } from "@/lib/duplicates";

/**
 * المرضى: بحث، وتصفّح، وإنشاء.
 *
 * الاستقبال تصل إلى هذه الشاشة من سؤالين: «ابحث لي عن فلان» و«سجّل مريضًا جديدًا».
 * فهما الشيئان الظاهران، والباقي — التصفّح والترقيم — يخدم الحالة الثالثة: أن تكون
 * تبحث عن اسم لا تتذكّر هجاءه.
 */

interface PatientSummary {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  medicalAlert: string | null;
}

interface PageResult { rows: PatientSummary[]; total: number; page: number; pageSize: number }

export default function PatientsPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [filter, setFilter] = useState<"all" | "alert" | "no_phone">("all");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [browsing, setBrowsing] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const filteredResults = useMemo(() => {
    return results.filter((p) => {
      if (filter === "alert") return Boolean(p.medicalAlert && p.medicalAlert.trim());
      if (filter === "no_phone") return !p.phone || !p.phone.trim();
      return true;
    });
  }, [results, filter]);

  const load = useCallback(async (term: string, targetPage: number) => {
    setLoading(true);
    try {
      const url = term.trim().length >= 2
        ? `/api/patients?q=${encodeURIComponent(term.trim())}`
        : `/api/patients?page=${targetPage}`;
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      if (Array.isArray(payload)) {
        setResults(payload as PatientSummary[]);
        setBrowsing(false);
      } else {
        const result = payload as PageResult;
        setResults(result.rows);
        setTotal(result.total);
        setPageSize(result.pageSize);
        setBrowsing(true);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  // بحث بعد توقف الكتابة لا مع كل حرف: طلبٌ لكل حرف يُثقل الاتصال ويعيد نتيجة «مح»
  // بعد أن كتبت الاستقبال «محمد».
  useEffect(() => {
    const timer = setTimeout(() => { void load(query, page); }, 300);
    return () => clearTimeout(timer);
  }, [query, page, load]);

  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold leading-tight">المرضى</h1>
          <p className="text-xs text-slate-500">
            {browsing && total > 0 ? `${total} مريضًا مسجّلًا` : "ابحث بالاسم أو رقم الجوال أو رقم الملف"}
          </p>
        </div>
        <button
          onClick={() => setAdding((open) => !open)}
          className="shrink-0 rounded-xl bg-brand-orange px-4 py-2 text-sm font-extrabold text-white"
        >
          {adding ? "إغلاق" : "+ مريض جديد"}
        </button>
      </header>

      {adding ? (
        <NewPatientForm
          onCreated={(patient) => { window.location.href = `/patients/${patient.id}`; }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      <input
        value={query}
        onChange={(event) => { setQuery(event.target.value); setPage(0); }}
        placeholder="اسم المريض أو رقمه"
        aria-label="بحث عن مريض"
        className="mb-3 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base outline-none focus:border-brand-blue"
      />

      {/* شريط الفلاتر السريرية السريعة */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
            filter === "all"
              ? "bg-navy-800 text-white shadow-xs"
              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          الكل ({results.length})
        </button>
        <button
          type="button"
          onClick={() => setFilter("alert")}
          className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
            filter === "alert"
              ? "bg-red-700 text-white shadow-xs"
              : "border border-red-200 bg-red-50/70 text-red-700 hover:bg-red-50"
          }`}
        >
          ⚠ تنبيهات طبية ({results.filter((p) => Boolean(p.medicalAlert && p.medicalAlert.trim())).length})
        </button>
        <button
          type="button"
          onClick={() => setFilter("no_phone")}
          className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
            filter === "no_phone"
              ? "bg-amber-600 text-white shadow-xs"
              : "border border-amber-200 bg-amber-50/70 text-amber-700 hover:bg-amber-50"
          }`}
        >
          📱 بلا هاتف ({results.filter((p) => !p.phone || !p.phone.trim()).length})
        </button>
      </div>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {loading && results.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : filteredResults.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          {query.trim() || filter !== "all" ? "لا توجد نتائج مطابقة لخيارات البحث أو الفلتر." : "لا مرضى مسجّلون بعد."}
        </p>
      ) : (
        <ul className="space-y-2">
          {filteredResults.map((patient) => (
            <li key={patient.id}>
              <a
                href={`/patients/${patient.id}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 hover:border-slate-300 transition-colors shadow-2xs"
              >
                <span className="min-w-0">
                  <span className="block truncate text-base font-extrabold text-navy-900">{patient.fullName}</span>
                  {patient.phone ? (
                    <span className="block text-xs text-slate-500 font-medium" dir="ltr">{patient.phone}</span>
                  ) : (
                    <span className="block text-xs text-amber-600 font-semibold">بلا رقم — لا يمكن تذكيره</span>
                  )}
                  {/* التنبيه الطبي يظهر في القائمة لا في الملف وحده: يُقرأ قبل أن يُفتح السجل */}
                  {patient.medicalAlert ? (
                    <span className="mt-1.5 inline-block rounded-lg bg-red-50 border border-red-200 px-2 py-0.5 text-[11px] font-bold text-red-700">
                      ⚠ {patient.medicalAlert}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs font-mono font-bold text-slate-400 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1">
                  {patient.patientNumber}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {browsing && lastPage > 0 ? (
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={page === 0}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold disabled:opacity-40"
          >
            السابق
          </button>
          <span className="text-xs font-bold text-slate-400">صفحة {page + 1} من {lastPage + 1}</span>
          <button
            onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
            disabled={page >= lastPage}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold disabled:opacity-40"
          >
            التالي
          </button>
        </div>
      ) : null}
    </main>
  );
}

function NewPatientForm({ onCreated, onCancel }: {
  onCreated: (patient: { id: number }) => void;
  onCancel: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<Gender>("unknown");
  const [birthYear, setBirthYear] = useState("");
  const [medicalAlert, setMedicalAlert] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);

  const send = async (confirmDuplicate: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/patients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, phone, gender, birthYear, medicalAlert, confirmDuplicate }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && Array.isArray(payload?.duplicates)) {
        setDuplicates(payload.duplicates as DuplicateMatch[]);
        setError(payload?.message ?? null);
        return;
      }
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return; }
      onCreated(payload as { id: number });
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // الاسم أو الهاتف تغيّر بعد التحذير: يُعاد الفحص بدل أن يمرّ التأكيد القديم.
    setDuplicates([]);
    void send(false);
  };

  return (
    <form onSubmit={submit} className="mb-4 rounded-2xl border border-brand-blue bg-white p-4">
      {/* الحد الأدنى فقط هنا: الاسم يكفي لفتح سجل، والبقية تُكمَّل من الملف لاحقًا.
          نموذجٌ من ثمانية حقول أمام مريض واقف ينتهي بسجلات نصف فارغة أو بلا سجل. */}
      <h2 className="mb-3 text-sm font-bold">مريض جديد</h2>

      {/*
        التحذير يُعرض **قبل** الحفظ لا بعده: بعد الحفظ يصير دمج ملفين عملًا محاسبيًا
        لا زرًّا. وكلٌّ منهم رابطٌ يُفتح — لأن القرار يحتاج النظر في الملف نفسه، لا
        في سطر يقول «قد يكون مكررًا».
      */}
      {duplicates.length > 0 ? (
        <div className="mb-3 rounded-xl border-2 border-warning-300 bg-warning-50 p-3">
          <p className="mb-2 text-xs font-bold text-warning-900">
            {error ?? "قد يكون هذا المريض مسجّلًا سلفًا."}
          </p>
          <ul className="mb-3 space-y-1.5">
            {duplicates.map((match) => (
              <li key={match.patient.id}>
                <a href={`/patients/${match.patient.id}`} target="_blank" rel="noopener"
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs hover:bg-slate-50">
                  <span className="font-bold text-navy-900">{match.patient.fullName}</span>
                  <span className="font-semibold text-slate-400 ltr-nums">{match.patient.patientNumber}</span>
                  {match.patient.phone ? (
                    <span className="font-semibold text-slate-400 ltr-nums">{match.patient.phone}</span>
                  ) : null}
                  <span className="mr-auto rounded-full bg-warning-100 px-2 py-0.5 font-bold text-warning-900">
                    {MATCH_LABEL[match.reason]}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void send(true)} disabled={busy}
              className="rounded-xl bg-warning-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">
              ليس أحدهم — أضف مريضًا جديدًا
            </button>
            <button type="button" onClick={() => { setDuplicates([]); setError(null); }}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
              تراجع
            </button>
          </div>
        </div>
      ) : null}
      <input
        value={fullName}
        onChange={(event) => setFullName(event.target.value)}
        placeholder="الاسم الكامل"
        aria-label="الاسم الكامل"
        autoFocus
        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
      />
      <div className="mb-2 flex flex-wrap gap-2">
        <input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="رقم الجوال"
          aria-label="رقم الجوال"
          dir="ltr"
          inputMode="tel"
          className="min-w-[9rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
        />
        <input
          value={birthYear}
          onChange={(event) => setBirthYear(event.target.value)}
          placeholder="سنة الميلاد"
          aria-label="سنة الميلاد"
          dir="ltr"
          inputMode="numeric"
          className="w-28 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
        />
      </div>
      <div className="mb-2 flex gap-2">
        {(["male", "female", "unknown"] as Gender[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setGender(option)}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${
              gender === option ? "border-brand-blue bg-brand-blue text-white" : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            {GENDER_LABEL[option]}
          </button>
        ))}
      </div>
      <input
        value={medicalAlert}
        onChange={(event) => setMedicalAlert(event.target.value)}
        placeholder="تنبيه طبي (اختياري) — حساسية، سكري، مميعات دم"
        aria-label="تنبيه طبي"
        className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
      />
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || fullName.trim().length < 2}
          className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
        >
          {busy ? "جارٍ الحفظ…" : "احفظ وافتح الملف"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600"
        >
          إلغاء
        </button>
      </div>
    </form>
  );
}
