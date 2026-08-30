"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONDITION_LABEL, PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER,
  STAGE_LABEL, SURFACES, buildChart, chartSummary, isPrimary, toothName, toUniversal,
  type ConditionStage, type ToothCondition, type ToothRecord, type ToothState,
} from "@/lib/dental";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { Icon } from "./Icon";

/**
 * مخطط الأسنان التفاعلي العالمي.
 *
 * يدعم نظامي الترقيم:
 * 1) ترقيم FDI الدولي (11–48 / 51–85)
 * 2) الترقيم العالمي Universal Numbering System (1–32 / A–T) المعتمد في الأنظمة الدولية (Dentrix / Open Dental)
 */

const CONDITION_COLOR: Record<ToothCondition, string> = {
  healthy: "fill-white stroke-slate-300",
  caries: "fill-red-500 stroke-red-700",
  filling: "fill-sky-700 stroke-sky-900",
  rct: "fill-purple-500 stroke-purple-700",
  crown: "fill-amber-400 stroke-amber-600",
  bridge: "fill-amber-300 stroke-amber-600",
  implant: "fill-emerald-500 stroke-emerald-700",
  missing: "fill-slate-200 stroke-slate-400",
  extracted: "fill-slate-200 stroke-slate-400 opacity-40",
  impacted: "fill-indigo-300 stroke-indigo-600",
  fracture: "fill-rose-400 stroke-rose-700",
  mobility: "fill-amber-100 stroke-amber-500",
  veneer: "fill-teal-300 stroke-teal-600",
  sealant: "fill-cyan-100 stroke-cyan-500",
  bracket: "fill-orange-400 stroke-orange-600",
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
  const [numberingSystem, setNumberingSystem] = useState<"fdi" | "universal">("fdi");

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

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-lg bg-white px-2.5 py-1 text-slate-600 shadow-card">
            {summary.charted} سنًّا مسجّلًا
          </span>
          {summary.caries > 0 ? (
            <span className="rounded-lg bg-red-50 px-2.5 py-1 text-red-700">{summary.caries} تسوّس</span>
          ) : null}
          {summary.planned > 0 ? (
            <span className="rounded-lg bg-amber-50 px-2.5 py-1 text-amber-900">{summary.planned} مخطَّط</span>
          ) : null}
          {summary.absent > 0 ? (
            <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-slate-500">{summary.absent} غائب</span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {/* محوّل نظام الترقيم الدولي والمحلي */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
            <button
              onClick={() => setNumberingSystem("fdi")}
              className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                numberingSystem === "fdi" ? "bg-navy-900 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
              title="نظام الاتحاد الدولي لطب الأسنان (FDI)"
            >
              FDI (11-48)
            </button>
            <button
              onClick={() => setNumberingSystem("universal")}
              className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                numberingSystem === "universal" ? "bg-navy-900 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
              title="الترقيم العالمي Universal (1-32 / A-T)"
            >
              العالمي (1-32)
            </button>
          </div>

          <button onClick={() => setShowPrimary((open) => !open)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-navy-800 hover:bg-slate-50">
            {showPrimary ? "إخفاء اللبنية" : "الأسنان اللبنية"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
        <div className="mx-auto w-fit">
          <Row teeth={PERMANENT_UPPER} chart={chart} selected={selected} onPick={setSelected} system={numberingSystem} />
          {showPrimary ? (
            <>
              <Row teeth={PRIMARY_UPPER} chart={chart} selected={selected} onPick={setSelected} system={numberingSystem} small />
              <div className="my-1 h-px bg-slate-200" />
              <Row teeth={PRIMARY_LOWER} chart={chart} selected={selected} onPick={setSelected} system={numberingSystem} small />
            </>
          ) : (
            <div className="my-2 h-px bg-slate-200" />
          )}
          <Row teeth={PERMANENT_LOWER} chart={chart} selected={selected} onPick={setSelected} system={numberingSystem} />
        </div>
      </div>

      {/* دليل ألوان الحالات السريرية */}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-[10px] text-slate-600">
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> تسوّس</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-sky-700" /> حشوة</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-purple-500" /> علاج عصب</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /> تاج/جسر</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> زرعة</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-slate-300" /> مفقود/مخلوع</span>
      </div>

      {loading ? (
        <p className="mt-3 text-center text-xs text-slate-400">جارٍ التحميل…</p>
      ) : selected === null ? (
        <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs font-semibold text-slate-400">
          انقر أي سن لترى حالته وتسجّل الإجراءات السريرية عليه.
        </p>
      ) : (
        <ToothPanel
          toothCode={selected} state={state} canEdit={canEdit} busy={busy}
          onSave={save} onClose={() => setSelected(null)} system={numberingSystem}
        />
      )}
    </div>
  );
}

function Row({ teeth, chart, selected, onPick, system = "fdi", small = false }: {
  teeth: number[];
  chart: Map<number, ToothState>;
  selected: number | null;
  onPick: (code: number) => void;
  system?: "fdi" | "universal";
  small?: boolean;
}) {
  return (
    <div className="flex gap-0.5" dir="ltr">
      {teeth.map((code) => {
        const state = chart.get(code);
        const condition = state?.current?.condition ?? "healthy";
        const planned = (state?.planned.length ?? 0) > 0;
        const active = selected === code;
        const displayLabel = system === "universal" ? toUniversal(code) : String(code);
        const isAbsent = state?.absent || condition === "missing" || condition === "extracted";

        return (
          <button
            key={code}
            onClick={() => onPick(code)}
            title={`${toothName(code)} (FDI: ${code}, Univ: ${toUniversal(code)})`}
            aria-label={toothName(code)}
            className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
              active ? "bg-navy-900" : "hover:bg-navy-50"
            }`}
          >
            <span className={`text-[9px] font-bold ${active ? "text-white" : "text-slate-400"}`}>
              {displayLabel}
            </span>
            <div className="relative">
              <svg viewBox="0 0 24 30" className={small ? "h-6 w-5" : "h-8 w-6"}>
                {/* شكل السن: تاجٌ وجذران مع تفاصيل بصرية واضحة */}
                <path
                  d="M12 2c-3 0-4.3 1.4-6.8 1.4C2.7 3.4 1 5.4 1 8.9c0 3 .9 5 1.7 7.7.6 2 .9 4.2 1.2 6.4.3 2.2.8 3.6 2.2 3.6 1.3 0 1.7-1.4 2.1-3.6.5-2.4.8-5 2.8-5s2.3 2.6 2.8 5c.4 2.2.8 3.6 2.1 3.6 1.4 0 1.9-1.4 2.2-3.6.3-2.2.6-4.4 1.2-6.4.8-2.7 1.7-4.7 1.7-7.7 0-3.5-1.7-5.5-4.2-5.5C16.3 3.4 15 2 12 2Z"
                  className={`${CONDITION_COLOR[condition]}`}
                  strokeWidth="1.2"
                />
                {isAbsent ? (
                  // علامة X للسن المفقود أو المخلوع
                  <path d="M4 5 L20 25 M20 5 L4 25" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                ) : null}
                {planned ? (
                  // الدائرة البرتقالية = خطة لم تُنفَّذ. تُرسم فوق الحالة لا بدلًا منها.
                  <circle cx="19" cy="5" r="4" className="fill-amber-500 stroke-white" strokeWidth="1.5" />
                ) : null}
              </svg>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ToothPanel({ toothCode, state, canEdit, busy, onSave, onClose, system = "fdi" }: {
  toothCode: number;
  state: ToothState | null;
  canEdit: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onClose: () => void;
  system?: "fdi" | "universal";
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
            {toothName(toothCode)}{" "}
            <span className="text-slate-400 ltr-nums">
              (FDI: {toothCode} · Univ: #{toUniversal(toothCode)})
            </span>
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
                  className="mr-auto rounded-lg bg-emerald-600 px-2.5 py-1 font-bold text-white disabled:opacity-40 hover:bg-emerald-700"
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

