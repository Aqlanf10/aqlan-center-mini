"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { previewLegacyReconciliation, type OpeningSnapshot } from "@/lib/legacy-reconciliation-preview";
import { allowedScopes, lineLinkage, validateLineSite, LINKAGE_SPECIALTY_LABEL, SITE_SCOPE_LABEL } from "@/lib/invoice-clinical-linkage";
import { LEGACY_CASE_LABEL, LEGACY_TREATMENT_MESSAGE } from "@/lib/legacy-treatment";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { ServiceSelect } from "./ServiceSelect";
import { useSession } from "./SessionProvider";
import { previewForRow, readPreviewLines, type PreviewState } from "./dental/invoice-preview-state";
import { ToothSelectionDialog } from "./dental/ToothSelectionDialog";
import {
  MODE_HINT, emptyToothFields, invoiceToothMode, selectionLabel, selectionOfRow, toothPayload, toothProblem, usesToothChart,
  type ToothFields, type ToothSelection,
} from "./dental/invoice-tooth-selection";

/**
 * (INV-LEGACY) «علاج بدأ قبل النظام» — نموذج في حساب المريض.
 *
 * الخدمة العلاجية من الدليل (التصنيف نفسه الذي يربط بنود الفاتورة) والسن، والمتفق عليه أصلًا، والمدفوع قبل النظام،
 * وتاريخ المعلومات، والعملة. المعاينة الحيّة بدالة المقارنة نفسها التي يتحقق بها الخادم (`previewLegacyReconciliation`):
 * المتبقي = المتفق − المدفوع، ولا سند للمدفوع سابقًا، والرصيد السابق = المتبقي وحده.
 * الحالة: تُعرض كما سيقرّرها الحفظ (قائمة/جسر/جديدة/اختيار) من معاينة الربط السريري القائمة.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }

const fieldClass = "min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm";

interface LegacyTreatmentFormProps {
  patientId: number;
  base: Currency;
  services: Service[];
  /** أرصدة المريض السابقة كما قرأها الحساب — للتنبيه، لا للحساب. */
  positions?: readonly OpeningSnapshot[];
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
}

export function LegacyTreatmentForm(props: LegacyTreatmentFormProps) {
  const session = useSession();
  const owner = JSON.stringify([props.patientId, session?.username, session?.role, session?.permissions ?? null]);
  if (!session) return null;
  return <LegacyTreatmentFormContent key={owner} {...props} />;
}

function LegacyTreatmentFormContent({ patientId, base, services, positions, busy, onSubmit, onCancel }: LegacyTreatmentFormProps) {
  const submitting = useRef(false);
  const generation = useRef(0);
  const [idempotencyKey] = useState(() => newIdempotencyKey("legacy"));
  const [serviceId, setServiceId] = useState<number | null>(null);
  /* (INV-LINK TOOTH) الموضع من مخطط الأسنان نفسه الذي تستعمله الفاتورة — لا حقل أرقام منفصل. */
  const [site, setSite] = useState<ToothFields>(() => emptyToothFields("none"));
  const [chartOpen, setChartOpen] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState("");
  const [currency, setCurrency] = useState<Currency>(base);
  const [agreedAmount, setAgreedAmount] = useState("");
  const [previouslyPaidAmount, setPreviouslyPaidAmount] = useState("");
  const [historicalAsOf, setHistoricalAsOf] = useState("");
  const [note, setNote] = useState("");
  const [caseRead, setCaseRead] = useState<PreviewState | null>(null);

  const clinicalServices = useMemo(
    () => services.filter((service) => lineLinkage({ serviceId: service.id, category: service.category }).kind === "clinical"),
    [services]);
  const service = clinicalServices.find((one) => one.id === serviceId) ?? null;
  const linkage = service ? lineLinkage({ serviceId: service.id, category: service.category }) : null;
  const specialtyLabel = linkage?.kind === "clinical" ? LINKAGE_SPECIALTY_LABEL[linkage.specialty] : null;
  const toothMode = invoiceToothMode(service?.category);
  const sitePayload = toothPayload(toothMode, site);
  const siteProblem = service ? toothProblem(toothMode, site) : null;
  const siteChip = selectionLabel(toothMode, site);
  const confirmSelection = (selection: ToothSelection) => {
    setChartOpen(false);
    setCaseId("");
    const teeth = [...selection.teeth].sort((a, b) => a - b);
    if (!service) return;
    // A whole crown/bridge/veneer episode is one immutable agreement, never N prices.
    // The shared parser still rejects multi-tooth RCT/implant/extraction episodes.
    const checked = validateLineSite({ category: service.category, toothCode: teeth[0] ?? null,
      surfaces: toothMode === "tooth_surfaces" ? selection.surfaces : null,
      episodeTeeth: teeth.length > 0 ? teeth : null, scope: teeth.length > 0 ? null : selection.scope });
    if (!checked.ok) {
      setSite(emptyToothFields(toothMode));
      setSiteError(checked.reason === "episode_split_required" ? LEGACY_TREATMENT_MESSAGE.episode_split_required
        : "بيانات موضع العلاج (الأسنان/الأسطح/النطاق) غير صالحة.");
      return;
    }
    if (teeth.length > 1 && toothMode !== "multi_tooth_episode") {
      setSite(emptyToothFields(toothMode));
      setSiteError("اختر سنًّا واحدًا لهذا العلاج؛ لا تختصر اختيار عدة أسنان إلى السن الأول.");
      return;
    }
    setSiteError(null);
    setSite({ toothCode: checked.site.toothCode, surfaces: checked.site.surfaces ?? "",
      scope: checked.site.scope, episodeTeeth: checked.site.episodeTeeth, groupId: null });
  };

  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const preview = previewLegacyReconciliation({
    draft: { currency, agreedAmount, previouslyPaidAmount, historicalAsOf }, today, positions,
  });
  const historical = preview.historical;
  const valid = preview.draftState === "valid" && historical !== null && historical.agreedMinor > 0 && service !== null
    && siteProblem === null && siteError === null;

  // Request identity and sequence both matter: A → B → A must not revive A's old evidence.
  const previewKey = JSON.stringify([patientId, serviceId, service?.category, sitePayload, caseId, currency, siteError]);
  if (caseRead && caseRead.requestKey !== previewKey) setCaseRead(null);
  useEffect(() => {
    const [ownerId, id, , place, chosen, money, selectionError] = JSON.parse(previewKey) as [
      number, number | null, string | null, Record<string, unknown>, string, string, string | null,
    ];
    const sequence = ++generation.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && sequence === generation.current;
    if (id === null || selectionError) return () => { generation.current += 1; controller.abort(); };
    setCaseRead({ requestKey: previewKey, status: "pending", byRow: new Map() });
    const timer = setTimeout(() => {
      void fetch("/api/invoices/clinical-preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ patientId: ownerId, currency: money, items: [{ serviceId: id, price: "1", quantity: 1, ...place, caseId: chosen }] }),
      }).then(async (response) => {
        if (!current()) return;
        if (!response.ok) {
          setCaseRead({ requestKey: previewKey, status: response.status === 401 || response.status === 403 ? "refused" : "unavailable",
            byRow: new Map(), message: "تعذّر التحقق من صلاحية تسجيل العلاج. أعد المحاولة بعد مراجعة الصلاحيات والاتصال." });
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (!current()) return;
        const byRow = readPreviewLines(payload, [{ key: "legacy", clinical: true }]);
        setCaseRead({ requestKey: previewKey, status: byRow ? "ready" : "unavailable", byRow: byRow ?? new Map() });
      }).catch(() => {
        if (current()) setCaseRead({ requestKey: previewKey, status: "unavailable", byRow: new Map() });
      });
    }, 300);
    return () => { generation.current += 1; controller.abort(); clearTimeout(timer); };
  }, [previewKey]);
  const evidence = previewForRow(caseRead, previewKey, "legacy");
  const casePreview = evidence.line;

  const existingOpening = positions?.find((position) => position.currency === currency) ?? null;
  const conflict = casePreview && (casePreview.item?.mode === "existing" || Boolean(casePreview.refusal)
    || casePreview.financialReviewRequired === true);
  const caseText = !casePreview?.case || serviceId === null ? null
    : casePreview.case.mode === "existing" ? `ستُربط بالحالة الموجودة: ${casePreview.case.title ?? `#${casePreview.case.id}`}`
    : casePreview.case.mode === "bridge" ? "ستُربط بحالة التقويم القائمة في وحدة التقويم"
    : casePreview.case.mode === "new" ? `ستُفتح حالة ${specialtyLabel ?? ""} موسومة «${LEGACY_CASE_LABEL}» — ويُراجع الطبيب الوضع الحالي وتُسجّل الموافقة الفعلية`
    : casePreview.case.mode === "choose" ? "للمريض أكثر من حالة مفتوحة لهذا التخصص — اختر الحالة"
    : null;

  return (
    <section aria-label="علاج بدأ قبل النظام" data-testid="legacy-treatment-form"
      className="mb-4 rounded-2xl border border-indigo-300 bg-white p-4">
      <h3 className="text-sm font-bold text-navy-900">علاج بدأ قبل النظام</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-slate-600">
        لحالةٍ بدأت قبل تشغيل النظام: يُحفظ الاتفاق الأصلي والمدفوع سابقًا كحقيقةٍ تاريخية، ويدخل الحساب المتبقي وحده رصيدًا سابقًا.
        لا فاتورة بكامل الاتفاق ولا سند للمدفوع سابقًا ولا حركة في الصندوق.
        تقدّم العلاج السابق غير معلوم من المبالغ؛ لا يُنشئ التسجيل جلسات سابقة أو موافقة علاج تلقائية.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <span className="mb-1 block text-xs font-semibold">الخدمة العلاجية</span>
          <ServiceSelect services={clinicalServices} value={serviceId} base={base} ariaLabel="الخدمة العلاجية"
            placeholder="— اختر العلاج من الدليل المصنف —"
            onChange={(id) => {
              const next = clinicalServices.find((one) => one.id === Number(id)) ?? null;
              setServiceId(id ? Number(id) : null); setCaseId(""); setSiteError(null);
              setSite(emptyToothFields(invoiceToothMode(next?.category)));
            }} />
          {specialtyLabel ? <p className="mt-1 text-[11px] font-bold text-indigo-800">التخصص: {specialtyLabel}</p> : null}
        </div>
        {service && toothMode !== "none" ? (
          <div className="min-w-0 sm:col-span-2" data-testid="legacy-tooth-site">
            <span className="mb-1 block text-xs font-semibold">موضع العلاج</span>
            <div className="flex flex-wrap items-center gap-2">
              {usesToothChart(toothMode) ? (
                <button type="button" data-testid="legacy-tooth-button" onClick={() => setChartOpen(true)}
                  className="min-h-11 rounded-xl border border-navy-800 bg-navy-50 px-3 py-2 text-xs font-bold text-navy-900">
                  🦷 {siteChip && site.toothCode !== null ? "تغيير" : "تحديد الأسنان"}
                </button>
              ) : null}
              {allowedScopes(toothMode).map((scope) => (
                <button key={scope} type="button" data-testid={`legacy-scope-${scope}`} aria-pressed={site.toothCode === null && site.scope === scope}
                  onClick={() => { setSite({ ...emptyToothFields(toothMode), scope }); setCaseId(""); setSiteError(null); }}
                  className={`min-h-11 rounded-xl border px-3 py-2 text-xs font-bold ${site.toothCode === null && site.scope === scope
                    ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-navy-900"}`}>
                  {SITE_SCOPE_LABEL[scope]}
                </button>
              ))}
              {siteChip ? (
                <span data-testid="legacy-tooth-chip" className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800">{siteChip}</span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">{toothMode === "multi_tooth_episode" ? "اختر كل أسنان الحلقة التي يغطيها الاتفاق التاريخي."
              : toothMode === "per_tooth_episode" ? "اختر سنًّا واحدًا لكل اتفاق تاريخي مستقل." : MODE_HINT[toothMode]}</p>
            {toothMode === "multi_tooth_episode" ? <p className="mt-1 text-[11px] text-indigo-900">
              الحلقة كاملةً اتفاق واحد وبند واحد. المبلغ والمدفوع سابقًا للحلقة كلها؛ لا يُضربان بعدد الأسنان ولا يُوزّعان عليها تخمينًا.
            </p> : null}
            {siteError || siteProblem ? (
              <p role="alert" data-testid="legacy-tooth-problem" className="mt-1 text-[11px] font-bold text-rose-700">{siteError ?? siteProblem}</p>
            ) : null}
          </div>
        ) : null}
        <label className="min-w-0 text-xs font-semibold">
          عملة الاتفاق
          <select value={currency} aria-label="عملة الاتفاق" className={fieldClass}
            onChange={(event) => { if (isCurrency(event.target.value)) { setCurrency(event.target.value); setAgreedAmount(""); setPreviouslyPaidAmount(""); } }}>
            {CURRENCIES.map((value) => <option key={value} value={value}>{CURRENCY_LABEL[value]}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-xs font-semibold">
          المبلغ المتفق عليه أصلًا
          <input value={agreedAmount} onChange={(event) => setAgreedAmount(event.target.value)}
            inputMode="decimal" dir="ltr" aria-label="المبلغ المتفق عليه أصلًا" className={fieldClass} />
        </label>
        <label className="min-w-0 text-xs font-semibold">
          المدفوع قبل النظام
          <input value={previouslyPaidAmount} onChange={(event) => setPreviouslyPaidAmount(event.target.value)}
            inputMode="decimal" dir="ltr" aria-label="المدفوع قبل النظام" className={fieldClass} />
        </label>
        <label className="min-w-0 text-xs font-semibold">
          تاريخ المعلومات التاريخية (حتى)
          <input type="date" value={historicalAsOf} max={today} onChange={(event) => setHistoricalAsOf(event.target.value)}
            dir="ltr" aria-label="تاريخ المعلومات التاريخية" className={fieldClass} />
        </label>
        <label className="min-w-0 text-xs font-semibold">
          ملاحظة (اختيارية)
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300}
            aria-label="ملاحظة الاتفاق التاريخي" className={fieldClass} />
        </label>
      </div>

      {service && evidence.status !== "ready" ? (
        <p role="status" data-testid="legacy-preview-read-state" className="mt-3 text-xs font-bold text-amber-900">
          {evidence.status === "pending" ? "جارٍ التحقق من ربط الحالة…" : evidence.message ?? casePreview?.refusalMessage
            ?? "تعذّر اعتماد ربط الحالة. راجع الاختيار أو أعد فتح النموذج للتحقق قبل الحفظ."}
        </p>
      ) : null}
      {caseText || conflict ? (
        <div data-testid="legacy-case-preview" className={`mt-3 rounded-xl border p-2.5 text-xs font-bold ${
          conflict ? "border-rose-200 bg-rose-50 text-rose-800" : "border-sky-200 bg-sky-50 text-sky-900"}`}>
          {caseText ? <p>{caseText}</p> : null}
          {casePreview?.case?.mode === "choose" || (casePreview?.case?.options.length ?? 0) > 1 ? (
            <select value={caseId} aria-label="حالة العلاج السابق" onChange={(event) => setCaseId(event.target.value)}
              className="mt-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
              <option value="">— اختر الحالة —</option>
              {casePreview?.case?.options.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
            </select>
          ) : null}
          {conflict ? <p>لهذا العلاج والسن بندٌ مفتوح أو مسجّل في النظام — سيُرفض الحفظ حتى تُراجع الخطة.</p> : null}
        </div>
      ) : null}

      <div aria-label="معاينة الاتفاق التاريخي" data-testid="legacy-treatment-preview" className="mt-3 space-y-2">
        {preview.message && preview.draftState !== "incomplete" ? (
          <p role="status" className="text-xs font-bold text-amber-900">{preview.message}</p>
        ) : null}
        {historical ? (
          <>
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <div className="rounded-xl bg-slate-50 p-2.5">
                <dt className="text-slate-500">المتفق عليه أصلًا</dt>
                <dd className="font-extrabold">{formatMoney(historical.agreedMinor, currency)}</dd>
              </div>
              <div className="rounded-xl bg-emerald-50 p-2.5">
                <dt className="text-emerald-700">المدفوع قبل النظام</dt>
                <dd className="font-extrabold text-emerald-800">{formatMoney(historical.previouslyPaidMinor, currency)}</dd>
              </div>
              <div className="rounded-xl bg-amber-50 p-2.5">
                <dt className="text-amber-800">المتبقي عند بدء النظام</dt>
                <dd data-testid="legacy-remaining" className="font-extrabold text-amber-900">{formatMoney(historical.remainingMinor, currency)}</dd>
              </div>
            </dl>
            <ul role="note" className="list-disc space-y-1 rounded-xl border border-indigo-200 bg-indigo-50 p-3 ps-6 text-xs leading-5 text-indigo-950">
              <li>لن يُنشأ إيصال للمبلغ المدفوع سابقًا، ولا يدخل الصندوق أو الوردية.</li>
              <li>{historical.remainingMinor > 0
                ? `الرصيد الافتتاحي = المتبقي فقط (${formatMoney(historical.remainingMinor, currency)}) — لا فاتورة بكامل الاتفاق.`
                : "الرصيد الافتتاحي = المتبقي فقط — والمتبقي صفر: الاتفاق مسدَّد تاريخيًّا ولا رصيد يُسجَّل."}</li>
              <li>العمل المرتبط باتفاق حيّ لا يُفوتر مرةً أخرى. يلزم توثيق الموافقة الفعلية ومراجعة التغطية قبل توقيع الزيارة؛ حفظ المسودة يبقى متاحًا.</li>
              <li>لا يُعرف المنجَز قبل النظام أو الباقي سريريًّا من مبلغ الاتفاق، ولا تُنشأ جلسات تاريخية افتراضية.</li>
            </ul>
            {existingOpening && historical.remainingMinor > 0 ? (
              <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                للمريض رصيدٌ سابق بهذه العملة ({formatMoney(existingOpening.openingMinor, currency)}). يُضاف إليه المتبقي فقط إن كان
                مسجّلًا من اتفاقات علاجٍ سابقة (للمدير)؛ وإن كان رصيدًا يدويًا قد يشمل هذا العلاج فسيُرفض الحفظ منعًا للحساب مرتين.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy || !valid || evidence.status !== "ready" || Boolean(conflict)}
          onClick={async () => {
            if (submitting.current || busy || !valid || evidence.status !== "ready" || conflict) return;
            submitting.current = true;
            try {
              await onSubmit({ serviceId, ...sitePayload, caseId: caseId || null, currency, agreedAmount,
                previouslyPaidAmount, historicalAsOf, note: note.trim() || null, idempotencyKey });
            } finally { submitting.current = false; }
          }}
          className="min-h-11 rounded-xl bg-indigo-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          {busy ? "جارٍ الحفظ…" : "احفظ العلاج السابق"}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600">
          إلغاء
        </button>
      </div>
      {chartOpen && service ? (
        <ToothSelectionDialog purpose="legacy_agreement" patientId={patientId} mode={toothMode} serviceName={service.name}
          initial={selectionOfRow(site)} onConfirm={confirmSelection} onCancel={() => setChartOpen(false)} />
      ) : null}
    </section>
  );
}
