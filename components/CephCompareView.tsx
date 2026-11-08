"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHANGE_LABEL, CEPH_ORDER_REQUIRED_NOTICE, CEPH_COMPARISON_INTERPRETATION, comparisonSummary, cephOrderLabels, isCephAcquisitionDate, resolveCephComparisonOrder, matchesCephComparisonOrdering, type CephComparisonOrdering, type Comparison } from "@/lib/cephCompare";
import { cephDocumentImageUrl, CEPH_IMAGE_UNAVAILABLE_NOTICE } from "@/lib/ceph-image-source";

/**
 * عرض مقارنة تحليلين سيفالومتريين مع التراكب.
 * (مقارنة من مستودع الوكيل الآخر؛ التراكب معاد كتابته لإحداثياتنا.)
 *
 * الجدول يقول «SNA نزل ستّ درجات»؛ والرسم يُري **أين تحرّك الوجه**. والاثنان
 * هنا مرتبطان ببصمة بيانات كل تحليل، مع ترتيب زمني واحد.
 */

interface CompareResponse {
  ordering: CephComparisonOrdering;
  before: {
    projectionSha256: string;
    id: number; phase: string; xrayDate: string | null;
    documentId: number; status: string; provenanceState: string; imageSha256: string | null; provenanceNotice?: string | null;
  };
  after: {
    projectionSha256: string;
    id: number; phase: string; xrayDate: string | null;
    documentId: number; status: string; provenanceState: string; imageSha256: string | null; provenanceNotice?: string | null;
  };
  comparison: Comparison;
}

interface SuperimposeResponse {
  ordering: CephComparisonOrdering;
  before: {
    projectionSha256: string;
    id: number; phase: string; xrayDate: string | null; documentId: number;
    status: string; provenanceState: string; imageSha256: string | null;
    documentWidth: number | null; documentHeight: number | null;
    lines: { from: { x: number; y: number }; to: { x: number; y: number }; label: string }[];
  };
  after: {
    projectionSha256: string;
    id: number; phase: string; xrayDate: string | null; documentId: number;
    status: string; provenanceState: string; imageSha256: string | null;
    lines: { from: { x: number; y: number }; to: { x: number; y: number }; label: string }[];
  };
  rotationDegrees: number;
  cranialBaseBefore: number;
  cranialBaseAfter: number;
}

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  midtreatment: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

function formatDate(value: string | null): string {
  return isCephAcquisitionDate(value) ? value : value == null ? "بلا تاريخ تصوير" : "تاريخ تصوير غير صالح";
}

function overlayImageUrl(before: Pick<SuperimposeResponse["before"], "documentId" | "status" | "provenanceState" | "imageSha256">): string | null {
  if (before.status === "completed" && before.provenanceState === "versioned") {
    return cephDocumentImageUrl(before.documentId, { sha256: before.imageSha256 });
  }
  // Unknown, discarded and unversioned completed records are not draft images.
  if (before.status === "draft" && before.provenanceState === "not_completed" && before.imageSha256 === null) {
    return cephDocumentImageUrl(before.documentId, null);
  }
  return null;
}

function sameOverlaySource(compared: CompareResponse["before"], placed: SuperimposeResponse["before"] | SuperimposeResponse["after"]): boolean {
  return typeof compared.projectionSha256 === "string" && /^[a-f0-9]{64}$/.test(compared.projectionSha256)
    && compared.projectionSha256 === placed.projectionSha256
    && compared.id === placed.id && compared.documentId === placed.documentId && compared.xrayDate === placed.xrayDate
    && compared.status === placed.status && compared.provenanceState === placed.provenanceState
    && compared.imageSha256 === placed.imageSha256 && overlayImageUrl(placed) !== null;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function responseStudy(value: unknown): value is CompareResponse["before"] {
  return record(value) && Number.isSafeInteger(value.id) && typeof value.id === "number" && value.id > 0
    && typeof value.phase === "string" && (value.xrayDate === null || typeof value.xrayDate === "string")
    && typeof value.projectionSha256 === "string" && /^[a-f0-9]{64}$/.test(value.projectionSha256)
    && typeof value.documentId === "number" && Number.isSafeInteger(value.documentId) && value.documentId > 0
    && ((value.status === "draft" && value.provenanceState === "not_completed" && value.imageSha256 === null)
      || (value.status === "completed" && value.provenanceState === "versioned" && typeof value.imageSha256 === "string" && /^[a-f0-9]{64}$/.test(value.imageSha256)))
    && (value.provenanceNotice == null || typeof value.provenanceNotice === "string");
}
function comparisonPayload(value: unknown, first: number, second: number, referenceId?: number): value is CompareResponse {
  if (!record(value) || !responseStudy(value.before) || !responseStudy(value.after)
      || !((value.before.id === first && value.after.id === second) || (value.before.id === second && value.after.id === first))
      || !matchesCephComparisonOrdering(value.ordering, value.before, value.after, referenceId)
      || !record(value.comparison)) return false;
  const table = value.comparison, policy = table.interpretation;
  if (!record(policy) || Object.keys(policy).length !== 2
      || policy.mode !== CEPH_COMPARISON_INTERPRETATION.mode || policy.reason !== CEPH_COMPARISON_INTERPRETATION.reason
      || !Array.isArray(table.measurements) || !stringList(table.onlyBefore) || !stringList(table.onlyAfter)
      || table.improved !== 0 || table.worsened !== 0 || table.steady !== 0) return false;
  const keys = new Set<string>();
  return table.measurements.every(row => {
    if (!record(row) || typeof row.key !== "string" || !row.key || row.key === "EXT_INDEX" || keys.has(row.key)
        || typeof row.name !== "string" || typeof row.unit !== "string"
        || !finite(row.before) || !finite(row.after) || !finite(row.delta) || row.delta !== row.after - row.before
        || row.gapBefore !== null || row.gapAfter !== null || row.direction !== "ungraded") return false;
    keys.add(row.key); return true;
  });
}
function overlayPayload(value: unknown, referenceId?: number): value is SuperimposeResponse {
  if (!record(value) || !responseStudy(value.before) || !responseStudy(value.after)
      || !matchesCephComparisonOrdering(value.ordering, value.before, value.after, referenceId)
      || ![value.rotationDegrees, value.cranialBaseBefore, value.cranialBaseAfter].every(finite)) return false;
  const validLines = (side: unknown) => record(side) && Array.isArray(side.lines) && side.lines.every(line => record(line)
    && record(line.from) && record(line.to) && [line.from.x, line.from.y, line.to.x, line.to.y].every(finite) && typeof line.label === "string");
  return validLines(value.before) && validLines(value.after);
}
type ReferenceChoice = { id: number; xrayDate: string | null };
function referenceChoices(value: unknown, first: number, second: number): ReferenceChoice[] | null {
  if (!record(value) || value.code !== "CEPH_ORDER_REQUIRED" || !["missing_date", "invalid_date", "equal_dates"].includes(String(value.reason))
      || !Array.isArray(value.choices) || value.choices.length !== 2) return null;
  const choices = value.choices;
  if (!choices.every(choice => record(choice) && (choice.xrayDate === null || typeof choice.xrayDate === "string"))
      || !choices.some(choice => choice.id === first) || !choices.some(choice => choice.id === second)) return null;
  const resolution = resolveCephComparisonOrder(choices[0] as ReferenceChoice, choices[1] as ReferenceChoice);
  return resolution.state === "unresolved" && resolution.reason === value.reason ? choices as ReferenceChoice[] : null;
}
const responseMessage = (value: unknown, fallback: string) => record(value) && typeof value.message === "string" ? value.message : fallback;

/** Keyed by the exact source and pair. Only a successful load of this image can
 * enable its SVG; stored dimensions alone are not evidence that pixels loaded. */
function CephComparisonImage({ src, overlay }: { src: string | null; overlay: SuperimposeResponse }) {
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const failure = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const unavailable = useCallback(() => {
    if (!live.current) return;
    failure.current = true; setImageSize(null); setFailed(true);
  }, []);
  const loaded = useCallback((image: HTMLImageElement) => {
    if (!live.current || failure.current) return;
    if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) { unavailable(); return; }
    setImageSize({ w: image.naturalWidth, h: image.naturalHeight });
  }, [unavailable]);
  const attach = useCallback((image: HTMLImageElement | null) => {
    // Also handles a cached image that completed before onLoad attached.
    if (image?.complete) loaded(image);
  }, [loaded]);
  if (!src) return <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">{CEPH_IMAGE_UNAVAILABLE_NOTICE}</p>;
  return <>
    <div className="relative mx-auto max-w-[720px] overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
      <img ref={attach} src={src} alt={`أشعة ${cephOrderLabels(overlay.ordering).before}`} className={failed ? "hidden" : "block w-full select-none"}
        draggable={false} onLoad={event => loaded(event.currentTarget)} onError={unavailable} />
      {imageSize && !failed && <svg className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={`0 0 ${imageSize.w} ${imageSize.h}`} preserveAspectRatio="none">
        {overlay.before.lines.map((line, index) => <line key={`b-${index}`}
          x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
          stroke="#0ea5e9" strokeWidth={Math.max(2, imageSize.w / 300)} opacity={0.85} />)}
        {overlay.after.lines.map((line, index) => <line key={`a-${index}`}
          x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
          stroke="#f43f5e" strokeWidth={Math.max(2, imageSize.w / 300)} strokeDasharray={Math.max(6, imageSize.w / 100)} opacity={0.9} />)}
      </svg>}
    </div>
    {failed ? <p role="alert" className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">{CEPH_IMAGE_UNAVAILABLE_NOTICE}</p>
      : !imageSize && <p role="status" className="mt-2 text-xs text-slate-500">جارٍ تحميل صورة الأشعة؛ التراكب غير متاح حتى اكتمال التحميل.</p>}
  </>;
}

type CephCompareProps = {
  first: number; second: number; patientName: string;
};
export function CephCompareView(props: CephCompareProps) {
  // A new pair is a new session, synchronously. No frame can retain old results,
  // errors, image dimensions or late events beneath the new pair's labels.
  return <CephComparePair key={`${props.first}:${props.second}`} {...props} />;
}

function CephComparePair(props: CephCompareProps) {
  const [referenceId, setReferenceId] = useState<number | undefined>(undefined);
  return <CephCompareSession key={referenceId ?? "automatic"} {...props} referenceId={referenceId} chooseReference={setReferenceId} />;
}

function CephCompareSession({ first, second, patientName, referenceId, chooseReference }: CephCompareProps & {
  referenceId?: number; chooseReference: (id: number | undefined) => void;
}) {
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [superimpose, setSuperimpose] = useState<SuperimposeResponse | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<ReferenceChoice[] | null>(null);
  const query = `first=${first}&second=${second}${referenceId === undefined ? "" : `&reference=${referenceId}`}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let compared: CompareResponse;
      try {
        const response = await fetch(`/api/ceph/compare?${query}`);
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) {
            const offered = response.status === 409 && referenceId === undefined ? referenceChoices(payload, first, second) : null;
            if (offered) setChoices(offered);
            else setError(responseMessage(payload, "تعذّرت المقارنة."));
          }
          return;
        }
        if (cancelled) return;
        if (!comparisonPayload(payload, first, second, referenceId)) {
          setError("استجابة المقارنة أو ترتيبها غير صالح أو لا يطابق التحليلين المطلوبين. أعد فتح المقارنة."); return;
        }
        compared = payload;
        setComparison(compared);
      } catch {
        if (!cancelled) setError("تعذّر الاتصال بالخادم.");
        return;
      }
      try {
        const response = await fetch(`/api/ceph/superimpose?${query}`);
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) setOverlayError(responseMessage(payload, "تعذّر التراكب."));
          return;
        }
        if (cancelled) return;
        const placed: unknown = payload;
        if (!overlayPayload(placed, referenceId) || placed.ordering.mode !== compared.ordering.mode
          || !sameOverlaySource(compared.before, placed.before) || !sameOverlaySource(compared.after, placed.after)) {
          setOverlayError("تغيّر ترتيب التحليلين أو بيانات المقارنة أو مصدر الصورة؛ التراكب غير متاح. أعد فتح المقارنة."); return;
        }
        setSuperimpose(placed);
      } catch {
        if (!cancelled) setOverlayError("تعذّر الاتصال بالخادم.");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [first, second, referenceId, query]);

  if (error) {
    return <div><p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">{error}</p>
      {referenceId !== undefined && <button type="button" onClick={() => chooseReference(undefined)}>إعادة التحقق من تواريخ التصوير</button>}</div>;
  }
  if (choices) return <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4" aria-label="اختيار مرجع المقارنة">
    <h1 className="font-bold">مقارنة التحليلات السيفالومترية — {patientName}</h1>
    <p role="status">{CEPH_ORDER_REQUIRED_NOTICE}</p>
    <p>اختيار المرجع يحدد اتجاه الطرح فقط؛ لا يغيّر تاريخ التصوير أو السجلات.</p>
    <div className="flex flex-wrap gap-3">{choices.map(choice => <button key={choice.id} type="button"
      className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-bold" onClick={() => chooseReference(choice.id)}>
      اختيار #{choice.id} مرجعًا ({formatDate(choice.xrayDate)})
    </button>)}</div>
  </section>;
  if (!comparison) {
    return <p className="p-4 text-sm text-slate-400">جارٍ تحميل المقارنة…</p>;
  }

  const { before, after, comparison: table, ordering } = comparison;
  // Old or malformed API summary text cannot restore normative conclusions.
  const summary = comparisonSummary(table);
  const labels = cephOrderLabels(ordering);
  const explicit = ordering.mode === "explicit_reference";
  const imageSrc = superimpose ? overlayImageUrl(superimpose.before) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-800">
            مقارنة التحليلات السيفالومترية — {patientName}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {labels.before}: #{before.id} ({!explicit && <>المرحلة المسجلة: {Object.hasOwn(PHASE_LABEL, before.phase) ? PHASE_LABEL[before.phase] : before.phase} — </>}{formatDate(before.xrayDate)})
            {" ← "}
            {labels.after}: #{after.id} ({!explicit && <>المرحلة المسجلة: {Object.hasOwn(PHASE_LABEL, after.phase) ? PHASE_LABEL[after.phase] : after.phase} — </>}{formatDate(after.xrayDate)})
          </p>
        </div>
        <a href={`/print/ceph-compare?${query}`} target="_blank" rel="noopener"
          className="rounded-xl bg-brand-navy px-4 py-2 text-xs font-extrabold text-white">
          طباعة تقرير المقارنة
        </a>
      </div>

      <p className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-bold text-sky-900">
        {labels.notice}
        {" "}{summary.ar}
      </p>

      {explicit && <button type="button" className="rounded-xl border px-4 py-2 text-xs font-bold" onClick={() => chooseReference(after.id)}>
        اختيار #{after.id} مرجعًا بدلًا من #{before.id}
      </button>}
      {[...new Set([before.provenanceNotice, after.provenanceNotice].filter(Boolean))].map(notice =>
        <p key={notice} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{notice}</p>)}
      {/* The reference remains fixed; comparison landmarks align onto it. */}
      {(
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="التراكب">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-extrabold text-navy-900">التراكب على قاعدة الجمجمة (SN عند S)</h2>
            <div className="flex items-center gap-3 text-[11px] font-bold">
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-6 bg-sky-600" /> {labels.before} (#{before.id})
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-6 bg-rose-500" /> {labels.after} (#{after.id}) — منقول
              </span>
            </div>
          </div>
          {overlayError ? (
            <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
              {overlayError}
            </p>
          ) : !superimpose ? (
            <p className="mt-3 text-xs text-slate-400">جارٍ حساب التراكب…</p>
          ) : (
            <div className="mt-3">
              <CephComparisonImage key={`${superimpose.before.id}:${superimpose.after.id}:${superimpose.before.projectionSha256}:${superimpose.after.projectionSha256}:${imageSrc ?? "unavailable"}`} src={imageSrc} overlay={superimpose} />
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-600 sm:grid-cols-4">
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  طول SN {labels.before}: {superimpose.cranialBaseBefore.toFixed(1)} ملم
                </p>
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  طول SN {labels.after}: {superimpose.cranialBaseAfter.toFixed(1)} ملم
                </p>
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  فرق طول SN ({labels.after} ناقص {labels.before}): {(superimpose.cranialBaseAfter - superimpose.cranialBaseBefore).toFixed(1)} ملم
                </p>
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  زاوية المحاذاة: {superimpose.rotationDegrees.toFixed(1)}°
                </p>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                التحجيم من معايرة الصورتين والمحاذاة على خط SN عند S. الفروق وصفية وتتأثر بدقة المعالم والمعايرة؛ لا تثبت نموًا أو أثرًا علاجيًا.
              </p>
            </div>
          )}
        </section>
      )}

      {/* جدول المقارنة: لا يُقارَن إلا ما قيس في الاثنتين */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="جدول المقارنة">
        <h2 className="text-xs font-extrabold text-navy-900">القياسات المشتركة بين التحليلين</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="p-2 text-right font-bold">القياس</th>
                <th className="p-2 font-bold">{labels.before}</th>
                <th className="p-2 font-bold">{labels.after}</th>
                <th className="p-2 font-bold">الفرق</th>
                <th className="p-2 text-right font-bold">الوصف</th>
              </tr>
            </thead>
            <tbody>
              {table.measurements.map((row) => (
                <tr key={row.key} className="border-b border-slate-100">
                  <td className="p-2 text-right font-bold text-slate-700">
                    {row.name}
                    <span className="mr-1 text-[10px] text-slate-400">{row.unit}</span>
                  </td>
                  <td className="p-2 text-center tabular-nums">{row.before.toFixed(1)}</td>
                  <td className="p-2 text-center tabular-nums font-bold">{row.after.toFixed(1)}</td>
                  <td className={`p-2 text-center tabular-nums font-extrabold text-slate-700`}>
                    {row.delta > 0 ? "+" : ""}{row.delta.toFixed(1)}
                  </td>
                  <td className="p-2">
                    <span className="inline-block rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-extrabold text-slate-600">
                      {explicit ? "فرق وصفي؛ التسلسل الزمني غير معروف" : CHANGE_LABEL.ungraded.ar}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {table.measurements.length === 0 ? (
          <p className="mt-3 text-xs font-bold text-amber-700">
            لا قياسًا مشتركًا بين التحليلين — لا يُقارَنان.
          </p>
        ) : null}
        {table.onlyBefore.length > 0 || table.onlyAfter.length > 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            قياساتٌ في أحدهما وحده لا تُقارَن (غياب النقطة ليس «ثباتًا»):
            {table.onlyBefore.length > 0 ? ` في ${labels.before} فقط ${table.onlyBefore.length}؛` : ""}
            {table.onlyAfter.length > 0 ? ` في ${labels.after} فقط ${table.onlyAfter.length}.` : ""}
          </p>
        ) : null}
      </section>
    </div>
  );
}
