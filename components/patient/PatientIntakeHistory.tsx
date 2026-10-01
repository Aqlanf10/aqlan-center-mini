"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INTAKE_CONDITIONS, type IntakeAnswers } from "@/lib/portal";
import { friendlyDateLong } from "@/lib/reminders";

interface IntakeFormView {
  id: number;
  answers: IntakeAnswers;
  createdAt: string;
}

const conditionLabel = new Map(INTAKE_CONDITIONS.map((item) => [item.key, item.label]));

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
          {compact ? "استمارة سابقة" : "آخر استمارة أرسلها المريض"}
        </p>
        <span className="text-[9px] font-semibold text-slate-400">
          {friendlyDateLong(form.createdAt.slice(0, 10))}
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
          <h3 className="text-xs font-extrabold text-navy-900">ما قاله المريض عن صحته</h3>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            بيانات أرسلها المريض بنفسه — لا تستبدل تقييم الطبيب ولا «التنبيه الطبي» الموثّق في الملف.
          </p>
        </div>
        {forms.length > 1 ? (
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-600">
            {forms.length} استمارات
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="rounded-xl bg-slate-50 px-3 py-3 text-center text-[10px] font-semibold text-slate-400">جارٍ تحميل الاستمارات…</p>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-[10px] font-bold text-rose-700">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-1 text-[9px] font-black text-rose-700 underline">إعادة المحاولة</button>
        </div>
      ) : !latest ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-3 py-3 text-[10px] font-semibold text-slate-400">
          لم يرسل المريض استمارة صحية رقمية بعد.
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
