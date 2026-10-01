"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INTAKE_CONDITIONS, type IntakeAnswers } from "@/lib/portal";
import { friendlyDateLong } from "@/lib/reminders";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

interface IntakeFormView {
  id: number;
  answers: IntakeAnswers;
  createdAt: string;
  /** موظفٌ دوّنها، أو null إن أرسلها المريض بنفسه. */
  recordedBy?: string | null;
}

const conditionLabel = new Map(INTAKE_CONDITIONS.map((item) => [item.key, item.label]));

/** التاريخ والساعة بتوقيت العيادة — السجل يُقرأ بلحظته لا بيومه فقط. */
function formatStamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ar-YE", {
      timeZone: CLINIC_ZONE_FALLBACK, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return friendlyDateLong(iso.slice(0, 10));
  }
}

const EMPTY_DRAFT = { conditions: [] as string[], allergies: "", medications: "", emergencyName: "", emergencyPhone: "", note: "" };

/**
 * تدوين تحديثٍ قاله المريض للطاقم — يُحفظ نسخةً جديدة في السجل (لا يعدّل السابقة).
 * يبدأ من آخر نسخة ليغيّر الموظف ما تغيّر فقط.
 */
function IntakeUpdateForm({ patientId, from, onSaved }: {
  patientId: number;
  from: IntakeAnswers | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(() => from ? {
    conditions: [...from.conditions],
    allergies: from.allergies ?? "", medications: from.medications ?? "",
    emergencyName: from.emergencyName ?? "", emergencyPhone: from.emergencyPhone ?? "", note: from.note ?? "",
  } : EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (key: string) => setDraft((current) => ({
    ...current,
    conditions: current.conditions.includes(key)
      ? current.conditions.filter((one) => one !== key)
      : [...current.conditions, key],
  }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/intake-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر حفظ الاستمارة.");
        return;
      }
      onSaved();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };
  const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs";
  return (
    <form onSubmit={save} className="mt-3 space-y-2 rounded-2xl border border-sky-200 bg-sky-50/40 p-3">
      <p className="text-[10px] font-bold text-slate-500">
        ما يقوله المريض الآن — يُحفظ نسخةً جديدة باسمك، وتبقى النسخ السابقة كما هي.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {INTAKE_CONDITIONS.map((condition) => {
          const on = draft.conditions.includes(condition.key);
          return (
            <button key={condition.key} type="button" onClick={() => toggle(condition.key)} aria-pressed={on}
              className={`rounded-full border px-2.5 py-1.5 text-[10px] font-black ${on ? "border-rose-300 bg-rose-100 text-rose-800" : "border-slate-200 bg-white text-slate-600"}`}>
              {condition.label}
            </button>
          );
        })}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={draft.allergies} onChange={(e) => setDraft({ ...draft, allergies: e.target.value })} placeholder="الحساسيات" aria-label="الحساسيات" className={field} />
        <input value={draft.medications} onChange={(e) => setDraft({ ...draft, medications: e.target.value })} placeholder="الأدوية" aria-label="الأدوية" className={field} />
        <input value={draft.emergencyName} onChange={(e) => setDraft({ ...draft, emergencyName: e.target.value })} placeholder="اسم جهة الطوارئ" aria-label="اسم جهة الطوارئ" className={field} />
        <input value={draft.emergencyPhone} onChange={(e) => setDraft({ ...draft, emergencyPhone: e.target.value })} placeholder="هاتف الطوارئ" aria-label="هاتف الطوارئ" dir="ltr" inputMode="tel" className={field} />
      </div>
      <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="ملاحظة (اختياري)" aria-label="ملاحظة" className={field} />
      {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-[10px] font-bold text-rose-700">{error}</p> : null}
      <button type="submit" disabled={busy} className="w-full rounded-xl bg-navy-800 py-2.5 text-xs font-extrabold text-white disabled:opacity-40">
        {busy ? "جارٍ الحفظ…" : "احفظ نسخة جديدة"}
      </button>
    </form>
  );
}

function ValueLine({ label, value, danger = false }: {
  label: string;
  value: string | null | undefined;
  danger?: boolean;
}) {
  if (!value?.trim()) return null;
  return (
    <div className={`rounded-xl px-3 py-2 ${danger ? "bg-rose-50" : "bg-slate-50"}`}>
      <p className={`text-[9px] font-black ${danger ? "text-rose-500" : "text-slate-400"}`}>{label}</p>
      <p className={`mt-0.5 text-[11px] font-bold leading-5 ${danger ? "text-rose-800" : "text-slate-700"}`}>{value}</p>
    </div>
  );
}

function IntakeCard({ form, compact = false }: { form: IntakeFormView; compact?: boolean }) {
  const labels = form.answers.conditions
    .map((key) => conditionLabel.get(key) ?? key)
    .filter(Boolean);

  return (
    <article className={`rounded-2xl border ${compact ? "border-slate-200 bg-white p-3" : "border-sky-200 bg-sky-50/35 p-4"}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-black text-slate-700">
          {compact ? "استمارة سابقة" : "آخر استمارة صحية"}
          <span className="mr-1 font-semibold text-slate-400">
            · {form.recordedBy ? `دوّنها ${form.recordedBy}` : "أرسلها المريض"}
          </span>
        </p>
        <span className="text-[9px] font-semibold text-slate-400" dir="ltr">
          {formatStamp(form.createdAt)}
        </span>
      </div>

      {labels.length > 0 ? (
        <div className="mb-2">
          <p className="mb-1 text-[9px] font-black text-rose-500">حالات صحية أبلغ عنها المريض</p>
          <div className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <span key={label} className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-[9px] font-black text-rose-700">
                {label}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="mb-2 rounded-xl bg-emerald-50 px-3 py-2 text-[10px] font-bold text-emerald-700">
          لم يحدد المريض حالةً مرضية في هذه الاستمارة.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <ValueLine label="الحساسيات كما كتبها المريض" value={form.answers.allergies} danger />
        <ValueLine label="الأدوية التي ذكرها" value={form.answers.medications} />
        <ValueLine label="ملاحظة المريض" value={form.answers.note} />
        <ValueLine
          label="جهة اتصال الطوارئ"
          value={[
            form.answers.emergencyName,
            form.answers.emergencyPhone,
          ].filter(Boolean).join(" · ") || null}
        />
      </div>
    </article>
  );
}

export function PatientIntakeHistory({ patientId }: { patientId: number }) {
  const [forms, setForms] = useState<IntakeFormView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/intake-history`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setForms(Array.isArray(payload?.forms) ? payload.forms : []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const latest = forms[0] ?? null;
  const previous = useMemo(() => forms.slice(1), [forms]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="ما قاله المريض عن صحته">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-extrabold text-navy-900">الاستمارة الصحية · ما قاله المريض</h3>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            كلام المريض كما قاله — لا يستبدل تقييم الطبيب ولا «التنبيه الطبي» الموثّق في الملف.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {forms.length > 1 ? (
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-600">
              {forms.length} استمارات
            </span>
          ) : null}
          {!loading && !error ? (
            <button type="button" onClick={() => setUpdating((open) => !open)}
              className="rounded-full border border-sky-300 bg-white px-2.5 py-1 text-[9px] font-black text-sky-800">
              {updating ? "إغلاق" : "+ تدوين تحديث"}
            </button>
          ) : null}
        </div>
      </div>

      {updating ? (
        <IntakeUpdateForm
          key={latest?.id ?? 0}
          patientId={patientId}
          from={latest?.answers ?? null}
          onSaved={() => { setUpdating(false); void load(); }}
        />
      ) : null}

      {loading ? (
        <p className="rounded-xl bg-slate-50 px-3 py-3 text-center text-[10px] font-semibold text-slate-400">جارٍ تحميل الاستمارات…</p>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-[10px] font-bold text-rose-700">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-1 text-[9px] font-black text-rose-700 underline">إعادة المحاولة</button>
        </div>
      ) : !latest ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-3 py-3 text-[10px] font-semibold text-slate-400">
          لا توجد استمارة صحية بعد — يرسلها المريض من البوابة أو يدوّنها الطاقم.
        </p>
      ) : (
        <>
          <IntakeCard form={latest} />
          {previous.length > 0 ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setHistoryOpen((open) => !open)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] font-black text-slate-600 hover:bg-slate-50"
              >
                {historyOpen ? "إخفاء الاستمارات السابقة" : `عرض الاستمارات السابقة (${previous.length})`}
              </button>
              {historyOpen ? (
                <div className="mt-2 space-y-2">
                  {previous.map((form) => <IntakeCard key={form.id} form={form} compact />)}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
