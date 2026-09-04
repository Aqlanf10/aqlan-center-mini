"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONDITION_LABEL, PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER,
  STAGE_LABEL, SURFACES, buildChart, chartSummary, isPrimary, toothName, toUniversal,
  calculatePerioAssessment, type ConditionStage, type ToothCondition, type ToothRecord, type ToothState,
  type ToothPerioRecord, type PerioAssessmentSummary, type PerioSite,
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
  const [chartMode, setChartMode] = useState<"odontogram" | "perio">("odontogram");
  const [perioRecords, setPerioRecords] = useState<Record<number, ToothPerioRecord>>({});

  const [perioActiveTooth, setPerioActiveTooth] = useState<number | null>(null);

  const perioSummary = useMemo(
    () => calculatePerioAssessment(Object.values(perioRecords)),
    [perioRecords],
  );


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
  }, [busy, load, patientId]);

  const state = selected !== null ? (chart.get(selected) ?? null) : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-base font-extrabold text-navy-900">مخطط الأسنان السريري</h2>
          <p className="text-xs text-slate-500">
            سجّل حالات الأسنان، خطط المعالجة، والتقييم اللثوي بنظام دولي تفاعلي.
          </p>
        </div>

        {/* أزرار التبديل والخيارات */}
        <div className="flex flex-wrap items-center gap-2">
          {/* تبديل وضع المخطط: أسنان / لثة */}
          <div className="flex rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setChartMode("odontogram")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                chartMode === "odontogram"
                  ? "bg-white text-navy-900 shadow-sm"
                  : "text-slate-600 hover:text-navy-900"
              }`}
            >
              <span>مخطط الأسنان (Odontogram)</span>
            </button>
            <button
              type="button"
              onClick={() => setChartMode("perio")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                chartMode === "perio"
                  ? "bg-white text-navy-900 shadow-sm"
                  : "text-slate-600 hover:text-navy-900"
              }`}
            >
              <span>مخطط اللثة (Perio Chart)</span>
            </button>
          </div>

          {/* نظام الترقيم: FDI / Universal */}
          <div className="flex rounded-xl border border-slate-200 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setNumberingSystem("fdi")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-all ${
                numberingSystem === "fdi"
                  ? "bg-navy-900 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
              title="نظام الاتحاد الفيدرالي الدولي (FDI) - الأكثر شيوعًا عالميًا"
            >
              FDI
            </button>
            <button
              type="button"
              onClick={() => setNumberingSystem("universal")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-all ${
                numberingSystem === "universal"
                  ? "bg-navy-900 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
              title="نظام الترقيم العالمي (Universal Numbering System 1-32)"
            >
              Universal (1-32)
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800">
          {error}
        </div>
      ) : null}

      {chartMode === "odontogram" ? (
        <>
          {/* ملخص المخطط السني */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-bold text-slate-700">الملخص:</span>
              <span className="text-slate-600">المسجّل: <strong>{summary.charted}</strong></span>
              <span className="text-red-700">تسوّس: <strong>{summary.caries}</strong></span>
              <span className="text-amber-700">مخطط: <strong>{summary.planned}</strong></span>
              <span className="text-emerald-700">منجز: <strong>{summary.completed}</strong></span>
              <span className="text-slate-500">مفقود: <strong>{summary.absent}</strong></span>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPrimary}
                  onChange={(e) => setShowPrimary(e.target.checked)}
                  className="rounded border-slate-300 text-navy-900 focus:ring-navy-900"
                />
                <span>إظهار الأسنان اللبنية (أطفال)</span>
              </label>
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
              onSwitchToPerio={(code) => {
                setPerioActiveTooth(code);
                setChartMode("perio");
              }}
            />
          )}
        </>
      ) : (
        <PerioChartView
          teethUpper={PERMANENT_UPPER}
          teethLower={PERMANENT_LOWER}
          system={numberingSystem}
          records={perioRecords}
          initialTooth={perioActiveTooth}
          onUpdate={(rec) => setPerioRecords((prev) => ({ ...prev, [rec.toothCode]: rec }))}
          canEdit={canEdit}
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

function ToothPanel({
  toothCode,
  state,
  canEdit,
  busy,
  onSave,
  onClose,
  system = "fdi",
  onSwitchToPerio,
}: {
  toothCode: number;
  state: ToothState | null;
  canEdit: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onClose: () => void;
  system?: "fdi" | "universal";
  onSwitchToPerio?: (code: number) => void;
}) {
  const [condition, setCondition] = useState<ToothCondition>("caries");
  const [stage, setStage] = useState<ConditionStage>("existing");
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const needsSurfaces = condition === "caries" || condition === "filling" || condition === "sealant";

  const SURFACE_DESCRIPTIONS: Record<string, { label: string; desc: string }> = {
    M: { label: "M", desc: "إنسي (Mesial)" },
    O: { label: "O", desc: "إطباقي (Occlusal)" },
    D: { label: "D", desc: "وحشي (Distal)" },
    B: { label: "B", desc: "دهليزي (Buccal)" },
    L: { label: "L", desc: "لساني (Lingual)" },
  };

  return (
    <section
      className="mt-4 rounded-2xl border-2 border-navy-900 bg-white p-5 shadow-lg transition-all animate-in fade-in slide-in-from-top-2 duration-200"
      aria-label={toothName(toothCode)}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy-900 text-white font-black text-sm shadow-md">
            {system === "universal" ? `#${toUniversal(toothCode)}` : toothCode}
          </div>
          <div>
            <h3 className="text-sm font-black text-navy-900">
              {toothName(toothCode)}{" "}
              <span className="text-xs font-medium text-slate-400 ltr-nums">
                (FDI: {toothCode} · Universal: #{toUniversal(toothCode)})
              </span>
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded-md px-2 py-0.5 font-bold ${
                  state?.current
                    ? "bg-slate-100 text-slate-800"
                    : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {state?.current
                  ? `الحالة السارية: ${CONDITION_LABEL[state.current.condition]}${
                      state.current.surfaces ? ` (${state.current.surfaces})` : ""
                    }`
                  : "سليم / لا توجد معالجة سابقة"}
              </span>
              {isPrimary(toothCode) ? (
                <span className="rounded-md bg-amber-50 px-2 py-0.5 font-bold text-amber-700">
                  سن لبني (طفل)
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onSwitchToPerio && (
            <button
              type="button"
              onClick={() => onSwitchToPerio(toothCode)}
              className="flex items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-800 hover:bg-teal-100 transition-colors"
            >
              <span>🌿 سبر اللثة (Perio Probe)</span>
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"
          >
            <Icon name="back" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* خطط العلاج المرصودة مسبقاً لهذا السن */}
      {state && state.planned.length > 0 ? (
        <div className="mb-4 space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <span className="text-xs font-bold text-amber-900 block mb-1">
            إجراءات مخططة قيد الانتظار لهذا السن:
          </span>
          {state.planned.map((plan) => (
            <div
              key={plan.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs shadow-xs border border-amber-100"
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                <span className="font-bold text-slate-800">
                  {CONDITION_LABEL[plan.condition]}
                  {plan.surfaces ? ` (${plan.surfaces})` : ""}
                </span>
                {plan.note && <span className="text-slate-500 text-[11px]">— {plan.note}</span>}
              </div>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    onSave({
                      toothCode,
                      condition: plan.condition,
                      stage: "completed",
                      surfaces: plan.surfaces,
                      note: plan.note,
                    })
                  }
                  disabled={busy}
                  className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40 shadow-xs"
                >
                  ✓ تعليم كمنجز
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {canEdit ? (
        <div className="space-y-4">
          {/* اختيار نوع الحالة السريرية */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              الحالة السريرية (Dental Condition):
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ORDERED_CONDITIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setCondition(option)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                    condition === option
                      ? "bg-navy-900 text-white shadow-sm scale-105"
                      : "border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 hover:border-slate-300"
                  }`}
                >
                  {CONDITION_LABEL[option]}
                </button>
              ))}
            </div>
          </div>

          {/* مرحلة الإجراء */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              تصنيف المعالجة (Stage):
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(STAGE_LABEL) as ConditionStage[]).map((option) => {
                const isCurrent = stage === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setStage(option)}
                    className={`rounded-xl p-2.5 text-center text-xs font-bold transition-all border ${
                      isCurrent
                        ? option === "planned"
                          ? "border-amber-500 bg-amber-500 text-white shadow-md shadow-amber-500/20"
                          : option === "completed"
                          ? "border-emerald-600 bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                          : "border-navy-900 bg-navy-900 text-white shadow-md shadow-navy-900/20"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <div>{STAGE_LABEL[option]}</div>
                    <span className="text-[10px] font-normal opacity-80 block mt-0.5">
                      {option === "existing"
                        ? "موجود مسبقًا لدى المريض"
                        : option === "planned"
                        ? "يضاف لخطة العلاج المقترحة"
                        : "تم إنجازه بالعيادة اليوم"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* اختيار الأسطح إن كان الإجراء يتطلب ذلك */}
          {needsSurfaces ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
              <label className="block text-xs font-bold text-slate-700 mb-2">
                أسطح السن المعنية (Tooth Surfaces - M D O B L):
              </label>
              <div className="grid grid-cols-5 gap-2">
                {SURFACES.map((surface) => {
                  const active = surfaces.includes(surface);
                  const meta = SURFACE_DESCRIPTIONS[surface];
                  return (
                    <button
                      key={surface}
                      type="button"
                      onClick={() =>
                        setSurfaces((current) =>
                          current.includes(surface)
                            ? current.filter((item) => item !== surface)
                            : [...current, surface],
                        )
                      }
                      className={`flex flex-col items-center justify-center rounded-xl p-2 text-center transition-all border ${
                        active
                          ? "border-navy-900 bg-navy-900 text-white shadow-sm"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                    >
                      <span className="text-sm font-black">{meta?.label || surface}</span>
                      <span className="text-[9px] font-semibold mt-0.5 opacity-80">{meta?.desc || ""}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* الملاحظة السريرية */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              ملاحظات سريرية تفصيلية (اختياري):
            </label>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="مثال: تسوس عميق قرب الحجرة اللبية، يحتاج تبطين..."
              aria-label="ملاحظة"
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 outline-none focus:border-navy-900 focus:ring-2 focus:ring-navy-900/10"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                onSave({
                  toothCode,
                  condition,
                  stage,
                  surfaces: surfaces.join("") || null,
                  note: note.trim() || null,
                });
                setNote("");
                setSurfaces([]);
              }}
              disabled={busy}
              className="flex-1 rounded-xl bg-navy-900 py-3 text-xs font-extrabold text-white shadow-md shadow-navy-900/20 hover:bg-navy-800 active:scale-95 disabled:opacity-40 transition-all"
            >
              {busy ? "جارٍ الحفظ..." : "تثبيت الحالة على المخطط السني"}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs font-semibold text-slate-400">
          المخطط السني يُسجَّل بواسطة الطبيب أو المساعد المرخص.
        </p>
      )}

      {/* سجل وتاريخ السن الموثق */}
      {state && state.history.length > 0 ? (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <details className="group">
            <summary className="flex cursor-pointer items-center justify-between text-xs font-bold text-slate-600 hover:text-navy-900">
              <span>سجل التوثيق التاريخي لهذا السن ({state.history.length})</span>
              <span className="text-[10px] text-slate-400 group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <ul className="mt-3 space-y-2">
              {[...state.history].reverse().map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/80 p-2.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-navy-900">{CONDITION_LABEL[row.condition]}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        row.stage === "completed"
                          ? "bg-emerald-100 text-emerald-800"
                          : row.stage === "planned"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-slate-200 text-slate-700"
                      }`}
                    >
                      {STAGE_LABEL[row.stage]}
                    </span>
                    {row.surfaces ? (
                      <span className="rounded bg-navy-100 px-1.5 py-0.5 text-[10px] font-bold text-navy-800 ltr-nums">
                        {row.surfaces}
                      </span>
                    ) : null}
                    {row.note && <span className="text-slate-500 text-[11px]">«{row.note}»</span>}
                  </div>
                  <span className="text-[11px] text-slate-400">
                    {row.recordedBy} · {row.recordedAt.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function PerioChartView({
  teethUpper,
  teethLower,
  system,
  records,
  initialTooth,
  onUpdate,
  canEdit,
}: {
  teethUpper: number[];
  teethLower: number[];
  system: "fdi" | "universal";
  records: Record<number, ToothPerioRecord>;
  initialTooth?: number | null;
  onUpdate: (rec: ToothPerioRecord) => void;
  canEdit: boolean;
}) {
  const [activeTooth, setActiveTooth] = useState<number | null>(initialTooth ?? teethUpper[0] ?? 16);

  useEffect(() => {
    if (initialTooth) {
      setActiveTooth(initialTooth);
    }
  }, [initialTooth]);

  const activeRecord: ToothPerioRecord = activeTooth
    ? records[activeTooth] ?? {
        toothCode: activeTooth,
        facial: [
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
        ],
        lingual: [
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
        ],
      }
    : {
        toothCode: 16,
        facial: [
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
        ],
        lingual: [
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
          { depth: 2, bleeding: false },
        ],
      };

  const updateSite = (
    surface: "facial" | "lingual",
    siteIndex: 0 | 1 | 2,
    field: "depth" | "bleeding",
    value: any,
  ) => {
    if (!canEdit || !activeTooth) return;
    const current = { ...activeRecord };
    const updatedSurface = [...current[surface]] as [PerioSite, PerioSite, PerioSite];
    updatedSurface[siteIndex] = {
      ...updatedSurface[siteIndex],
      [field]: value,
    };
    const updated: ToothPerioRecord = {
      ...current,
      toothCode: activeTooth,
      [surface]: updatedSurface,
    };
    onUpdate(updated);
  };

  const getSiteBadge = (depth: number, bleeding: boolean) => {
    let bg = "bg-emerald-50 text-emerald-800 border-emerald-300";
    if (depth === 4) bg = "bg-amber-100 text-amber-900 border-amber-400 font-bold";
    if (depth >= 5) bg = "bg-red-500 text-white border-red-600 font-black";
    return bg;
  };

  const renderToothCell = (code: number) => {
    const rec = records[code];
    const facial = rec?.facial ?? [{ depth: 2, bleeding: false }, { depth: 2, bleeding: false }, { depth: 2, bleeding: false }];
    const lingual = rec?.lingual ?? [{ depth: 2, bleeding: false }, { depth: 2, bleeding: false }, { depth: 2, bleeding: false }];
    const hasBleed = [...facial, ...lingual].some((s) => s.bleeding);
    const maxDepth = Math.max(...[...facial, ...lingual].map((s) => s.depth));
    const isSelected = activeTooth === code;
    const label = system === "universal" ? toUniversal(code) : String(code);

    return (
      <button
        key={code}
        type="button"
        onClick={() => setActiveTooth(code)}
        className={`flex flex-col items-center rounded-xl border p-1.5 transition-all text-center ${
          isSelected
            ? "border-navy-900 bg-navy-50 ring-2 ring-navy-800 shadow-xs"
            : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
        }`}
      >
        <span className="text-[10px] font-black text-navy-900">{label}</span>
        <div className="my-1 flex items-center justify-center gap-0.5">
          {facial.map((site, i) => (
            <span
              key={i}
              className={`h-4 min-w-[14px] px-0.5 rounded text-[9px] font-bold flex items-center justify-center ${getSiteBadge(
                site.depth,
                site.bleeding,
              )}`}
            >
              {site.depth}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[9px]">
          {hasBleed ? <span className="text-red-600 font-black" title="نزف عند السبر BOP">🩸</span> : null}
          {maxDepth >= 5 ? (
            <span className="rounded bg-red-100 px-1 text-[8px] font-black text-red-700">جيب</span>
          ) : null}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {/* فكي الأسنان */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-2 text-center text-xs font-bold text-slate-500">الفك العلوي (Maxilla)</div>
        <div className="grid grid-cols-8 md:grid-cols-16 gap-1.5 mx-auto w-fit" dir="ltr">
          {teethUpper.map(renderToothCell)}
        </div>

        <div className="my-3 border-t border-dashed border-slate-200" />

        <div className="grid grid-cols-8 md:grid-cols-16 gap-1.5 mx-auto w-fit" dir="ltr">
          {teethLower.map(renderToothCell)}
        </div>
        <div className="mt-2 text-center text-xs font-bold text-slate-500">الفك السفلي (Mandible)</div>
      </div>

      {/* لوحة تعديل قياسات السن المحدد */}
      {activeTooth ? (
        <div className="rounded-2xl border border-navy-800 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <h4 className="text-xs font-black text-navy-900">
              قياسات السن {system === "universal" ? toUniversal(activeTooth) : activeTooth} ({toothName(activeTooth)})
            </h4>
            <span className="text-[11px] text-slate-500">
              عمق السبر بالمليمتر (1-3mm طبيعي · 4mm التهاب · 5mm+ جيب عميق)
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* السطح الدهليزي / الخارجي */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="block text-xs font-black text-slate-700 mb-2">
                السطح الشفوي / الدهليزي (Facial / Buccal):
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(["Mesial (إنسي)", "Mid (وسط)", "Distal (وحشي)"] as const).map((pos, idx) => {
                  const site = activeRecord.facial[idx as 0 | 1 | 2];
                  return (
                    <div key={pos} className="rounded-lg bg-white p-2 border border-slate-200 text-center">
                      <span className="text-[10px] font-bold text-slate-500 block mb-1">{pos}</span>
                      <div className="flex items-center justify-center gap-1">
                        <select
                          value={site.depth}
                          disabled={!canEdit}
                          onChange={(e) => updateSite("facial", idx as 0 | 1 | 2, "depth", Number(e.target.value))}
                          className={`rounded-lg px-2 py-1 text-xs font-black border ${getSiteBadge(
                            site.depth,
                            site.bleeding,
                          )}`}
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                            <option key={d} value={d}>
                              {d} mm
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => updateSite("facial", idx as 0 | 1 | 2, "bleeding", !site.bleeding)}
                          title="نزف عند السبر (BOP)"
                          className={`h-7 w-7 rounded-lg border flex items-center justify-center text-xs transition-colors ${
                            site.bleeding
                              ? "border-red-500 bg-red-100 text-red-700"
                              : "border-slate-200 bg-white text-slate-400 hover:border-red-300"
                          }`}
                        >
                          🩸
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* السطح اللساني / الداخلي */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="block text-xs font-black text-slate-700 mb-2">
                السطح اللساني / الحنكي (Lingual / Palatal):
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(["Mesial (إنسي)", "Mid (وسط)", "Distal (وحشي)"] as const).map((pos, idx) => {
                  const site = activeRecord.lingual[idx as 0 | 1 | 2];
                  return (
                    <div key={pos} className="rounded-lg bg-white p-2 border border-slate-200 text-center">
                      <span className="text-[10px] font-bold text-slate-500 block mb-1">{pos}</span>
                      <div className="flex items-center justify-center gap-1">
                        <select
                          value={site.depth}
                          disabled={!canEdit}
                          onChange={(e) => updateSite("lingual", idx as 0 | 1 | 2, "depth", Number(e.target.value))}
                          className={`rounded-lg px-2 py-1 text-xs font-black border ${getSiteBadge(
                            site.depth,
                            site.bleeding,
                          )}`}
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                            <option key={d} value={d}>
                              {d} mm
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => updateSite("lingual", idx as 0 | 1 | 2, "bleeding", !site.bleeding)}
                          title="نزف عند السبر (BOP)"
                          className={`h-7 w-7 rounded-lg border flex items-center justify-center text-xs transition-colors ${
                            site.bleeding
                              ? "border-red-500 bg-red-100 text-red-700"
                              : "border-slate-200 bg-white text-slate-400 hover:border-red-300"
                          }`}
                        >
                          🩸
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


