"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONDITION_LABEL, PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER,
  STAGE_LABEL, SURFACES, buildChart, chartSummary, isPrimary, toothName,
  type ConditionStage, type ToothCondition, type ToothRecord, type ToothState,
} from "@/lib/dental";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { Icon } from "./Icon";

/**
 * مخطط الأسنان التفاعلي.
 *
 * الشاشة السريرية الأولى: الطبيب ينقر السن فيسجّل ما وجده أو ما نوى عمله. وترتيب
 * الأسنان **كما يراها وهو واقف أمام المريض** — يمين المريض على يسار الشاشة — لأن
 * مخططًا معكوسًا يجعله يسجّل التسوّس على السن المقابل، وهو خطأ لا يُكتشف إلا على
 * الكرسي.
 */

const CONDITION_COLOR: Record<ToothCondition, string> = {
  healthy: "fill-white stroke-slate-300",
  caries: "fill-danger-500 stroke-danger-700",
  filling: "fill-navy-700 stroke-navy-900",
  rct: "fill-accent-500 stroke-accent-700",
  crown: "fill-warning-500 stroke-warning-700",
  bridge: "fill-warning-300 stroke-warning-700",
  implant: "fill-info-500 stroke-info-700",
  missing: "fill-slate-200 stroke-slate-300",
  extracted: "fill-slate-200 stroke-slate-300",
  impacted: "fill-info-300 stroke-info-700",
  fracture: "fill-danger-300 stroke-danger-700",
  mobility: "fill-warning-100 stroke-warning-700",
  veneer: "fill-success-300 stroke-success-700",
  sealant: "fill-success-100 stroke-success-500",
  bracket: "fill-accent-200 stroke-accent-700",
};

const ORDERED_CONDITIONS: ToothCondition[] = [
  "caries", "filling", "rct", "crown", "bridge", "implant", "veneer", "sealant",
  "bracket", "impacted", "fracture", "mobility", "extracted", "missing", "healthy",
];

export function DentalChart({ patientId }: { patientId: number }) {
  const session = useSession();
  const canEdit = isAdmin(session?.role) || session?.role === "doctor";

  const [records, setRecords] = useState<ToothRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [showPrimary, setShowPrimary] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/chart`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setRecords(payload.records as ToothRecord[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  // المخطط يُبنى في المتصفّح من نفس الدالة التي يستعملها الخادم — لا نسخة ثانية.
  const chart = useMemo(() => buildChart(records), [records]);
  const summary = useMemo(() => chartSummary(chart), [chart]);

  const save = useCallback(async (body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/chart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الحفظ.");
      setError(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذّر الحفظ.");
    } finally {
      setBusy(false);
    }
  }, [busy, patientId, load]);

  const state = selected === null ? null : chart.get(selected) ?? null;

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-danger-300 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700">{error}</p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold">
        <span className="rounded-lg bg-white px-2.5 py-1 text-slate-600 shadow-card">
          {summary.charted} سنًّا مسجّلًا
        </span>
        {summary.caries > 0 ? (
          <span className="rounded-lg bg-danger-50 px-2.5 py-1 text-danger-700">{summary.caries} تسوّس</span>
        ) : null}
        {summary.planned > 0 ? (
          <span className="rounded-lg bg-warning-50 px-2.5 py-1 text-warning-900">{summary.planned} مخطَّط</span>
        ) : null}
        {summary.absent > 0 ? (
          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-slate-500">{summary.absent} غائب</span>
        ) : null}
        <button onClick={() => setShowPrimary((open) => !open)}
          className="mr-auto rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-navy-800">
          {showPrimary ? "إخفاء الأسنان اللبنية" : "إظهار الأسنان اللبنية"}
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
        <div className="mx-auto w-fit">
          <Row teeth={PERMANENT_UPPER} chart={chart} selected={selected} onPick={setSelected} />
          {showPrimary ? (
            <>
              <Row teeth={PRIMARY_UPPER} chart={chart} selected={selected} onPick={setSelected} small />
              <div className="my-1 h-px bg-slate-200" />
              <Row teeth={PRIMARY_LOWER} chart={chart} selected={selected} onPick={setSelected} small />
            </>
          ) : (
            <div className="my-2 h-px bg-slate-200" />
          )}
          <Row teeth={PERMANENT_LOWER} chart={chart} selected={selected} onPick={setSelected} />
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-center text-xs text-slate-400">جارٍ التحميل…</p>
      ) : selected === null ? (
        <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs font-semibold text-slate-400">
          انقر أي سن لترى حالته وتسجّل عليه.
        </p>
      ) : (
        <ToothPanel
          toothCode={selected} state={state} canEdit={canEdit} busy={busy}
          onSave={save} onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Row({ teeth, chart, selected, onPick, small = false }: {
  teeth: number[];
  chart: Map<number, ToothState>;
  selected: number | null;
  onPick: (code: number) => void;
  small?: boolean;
}) {
  return (
    /*
     * `dir="ltr"` على الصف وحده — والصفحة كلها RTL.
     *
     * ترتيب المصفوفة يبدأ بالربع الأول (18…11) وهو **يمين المريض**، ويجب أن يظهر
     * على **يسار الشاشة**: هكذا يرى الطبيب فم مريضه وهو واقف أمامه. وبلا هذا يقلبه
     * الاتجاه العربي فيصير المخطط مرآةً — فيسجّل الطبيب التسوّس على السن المقابل،
     * وهو خطأ لا يُكتشف إلا على الكرسي.
     */
    <div className="flex gap-0.5" dir="ltr">
      {teeth.map((code) => {
        const state = chart.get(code);
        const condition = state?.current?.condition ?? "healthy";
        const planned = (state?.planned.length ?? 0) > 0;
        const active = selected === code;
        return (
          <button
            key={code}
            onClick={() => onPick(code)}
            title={toothName(code)}
            aria-label={toothName(code)}
            className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
              active ? "bg-navy-900" : "hover:bg-navy-50"
            }`}
          >
            <span className={`text-[9px] font-bold ${active ? "text-white" : "text-slate-400"}`}>
              {code}
            </span>
            <svg viewBox="0 0 24 30" className={small ? "h-6 w-5" : "h-8 w-6"}>
              {/* شكل السن: تاجٌ وجذران — يكفي للتمييز البصري بلا تفاصيل تشوّش. */}
              <path
                d="M12 2c-3 0-4.3 1.4-6.8 1.4C2.7 3.4 1 5.4 1 8.9c0 3 .9 5 1.7 7.7.6 2 .9 4.2 1.2 6.4.3 2.2.8 3.6 2.2 3.6 1.3 0 1.7-1.4 2.1-3.6.5-2.4.8-5 2.8-5s2.3 2.6 2.8 5c.4 2.2.8 3.6 2.1 3.6 1.4 0 1.9-1.4 2.2-3.6.3-2.2.6-4.4 1.2-6.4.8-2.7 1.7-4.7 1.7-7.7 0-3.5-1.7-5.5-4.2-5.5C16.3 3.4 15 2 12 2Z"
                className={`${CONDITION_COLOR[condition]}`}
                strokeWidth="1.2"
              />
              {planned ? (
                // الدائرة البرتقالية = خطة لم تُنفَّذ. تُرسم فوق الحالة لا بدلًا منها.
                <circle cx="19" cy="5" r="4" className="fill-accent-500 stroke-white" strokeWidth="1.5" />
              ) : null}
            </svg>
          </button>
        );
      })}
    </div>
  );
}

function ToothPanel({ toothCode, state, canEdit, busy, onSave, onClose }: {
  toothCode: number;
  state: ToothState | null;
  canEdit: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [condition, setCondition] = useState<ToothCondition>("caries");
  const [stage, setStage] = useState<ConditionStage>("existing");
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const needsSurfaces = condition === "caries" || condition === "filling" || condition === "sealant";

  return (
    <section className="mt-3 rounded-2xl border-2 border-navy-800 bg-white p-4" aria-label={toothName(toothCode)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-navy-900">
            {toothName(toothCode)} <span className="text-slate-400 ltr-nums">({toothCode})</span>
          </h3>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500">
            {state?.current
              ? `الحالة: ${CONDITION_LABEL[state.current.condition]}${state.current.surfaces ? ` · ${state.current.surfaces}` : ""}`
              : "لا حالة مسجّلة"}
            {isPrimary(toothCode) ? " · سن لبني" : ""}
          </p>
        </div>
        <button onClick={onClose} aria-label="إغلاق" className="rounded-lg p-1 text-slate-400 hover:bg-slate-50">
          <Icon name="back" className="h-4 w-4" />
        </button>
      </div>

      {state && state.planned.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {state.planned.map((plan) => (
            <li key={plan.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-50 px-3 py-1.5 text-[11px]">
              <span className="font-bold text-warning-900">مخطَّط: {CONDITION_LABEL[plan.condition]}</span>
              {canEdit ? (
                <button
                  onClick={() => onSave({
                    toothCode, condition: plan.condition, stage: "completed",
                    surfaces: plan.surfaces, note: plan.note,
                  })}
                  disabled={busy}
                  className="mr-auto rounded-lg bg-success-500 px-2.5 py-1 font-bold text-white disabled:opacity-40"
                >
                  تمّ إنجازه
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canEdit ? (
        <>
          <div className="mb-2 flex flex-wrap gap-1">
            {ORDERED_CONDITIONS.map((option) => (
              <button key={option} onClick={() => setCondition(option)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${
                  condition === option ? "bg-navy-900 text-white" : "border border-slate-200 bg-white text-navy-800"
                }`}>
                {CONDITION_LABEL[option]}
              </button>
            ))}
          </div>

          <div className="mb-2 flex flex-wrap gap-1">
            {(Object.keys(STAGE_LABEL) as ConditionStage[]).map((option) => (
              <button key={option} onClick={() => setStage(option)}
                className={`rounded-lg px-3 py-1 text-[11px] font-bold ${
                  stage === option ? "bg-accent-500 text-white" : "border border-slate-200 bg-white text-slate-600"
                }`}>
                {STAGE_LABEL[option]}
              </button>
            ))}
          </div>

          {needsSurfaces ? (
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <span className="text-[11px] font-bold text-slate-500">الأسطح:</span>
              {SURFACES.map((surface) => (
                <button key={surface}
                  onClick={() => setSurfaces((current) =>
                    current.includes(surface)
                      ? current.filter((item) => item !== surface)
                      : [...current, surface])}
                  className={`h-7 w-7 rounded-lg text-[11px] font-bold ${
                    surfaces.includes(surface) ? "bg-navy-800 text-white" : "border border-slate-200 bg-white text-slate-600"
                  }`}>
                  {surface}
                </button>
              ))}
            </div>
          ) : null}

          <input value={note} onChange={(event) => setNote(event.target.value)}
            placeholder="ملاحظة (اختياري)" aria-label="ملاحظة"
            className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />

          <button
            onClick={() => {
              onSave({
                toothCode, condition, stage,
                surfaces: surfaces.join("") || null,
                note: note.trim() || null,
              });
              setNote("");
              setSurfaces([]);
            }}
            disabled={busy}
            className="w-full rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40"
          >
            ثبّت الحالة
          </button>
          <p className="mt-2 text-[10px] font-semibold leading-4 text-slate-400">
            التثبيت إضافة لا تعديل: الحالة السابقة تبقى في تاريخ السن، وهذا ما يجعل
            السجل قابلًا للتدقيق.
          </p>
        </>
      ) : (
        <p className="text-[11px] font-semibold text-slate-400">المخطط السني يُكتب من الطبيب.</p>
      )}

      {state && state.history.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
            تاريخ هذا السن ({state.history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {[...state.history].reverse().map((row) => (
              <li key={row.id} className="flex flex-wrap gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px]">
                <span className="font-bold text-navy-900">{CONDITION_LABEL[row.condition]}</span>
                <span className="text-slate-500">{STAGE_LABEL[row.stage]}</span>
                {row.surfaces ? <span className="text-slate-400 ltr-nums">{row.surfaces}</span> : null}
                <span className="mr-auto text-slate-400">
                  {row.recordedBy} · {row.recordedAt.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
