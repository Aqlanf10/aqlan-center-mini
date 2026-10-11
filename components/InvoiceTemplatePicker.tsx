"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InvoiceTemplatePreview, InvoiceTemplateSelection } from "@/lib/invoice-template";
import type { SpecialtyTemplate } from "@/lib/specialty-templates";
import { allowedScopes, SITE_SCOPE_LABEL } from "@/lib/invoice-clinical-linkage";
import { invoiceToothMode } from "./dental/invoice-tooth-selection";
import { invoiceTemplateRowKey, readInvoiceTemplateCatalog } from "./dental/invoice-template-preview";
import type { LinePreview } from "./dental/invoice-preview-state";
import { ToothSelectionDialog } from "./dental/ToothSelectionDialog";

type Service = { id: number; name: string; category: string | null };
export type InvoiceTemplateDraft = { template: SpecialtyTemplate; selection: InvoiceTemplateSelection };
type Site = NonNullable<InvoiceTemplateSelection["sites"]>[number];
const siteKey = (stepKey: string, toothCode: number | null) => JSON.stringify([stepKey, toothCode]);

/** Collects explicit references only. Prices, session schedules and billing
 * coverage are resolved by the canonical invoice preview/save transaction. */
export function InvoiceTemplatePicker({ patientId, authorityKey, services, doctors, disabled, draft,
  onChange, onCatalogReady, evidence, allowManual = true }: {
  patientId: number; authorityKey: string; services: readonly Service[];
  doctors: readonly { id: number; name: string }[]; disabled: boolean;
  draft: InvoiceTemplateDraft | null;
  allowManual?: boolean;
  onChange: (draft: InvoiceTemplateDraft | null) => void;
  onCatalogReady: (ready: boolean) => void;
  evidence: { template: InvoiceTemplatePreview; byRow: ReadonlyMap<string, LinePreview> } | null;
}) {
  // Identity is immutable render data; event/read lifecycle mutation lives only in the ref.
  const owner = useMemo(() => ({ patientId, authorityKey }), [patientId, authorityKey]);
  const lifetime = useRef<{ owner: object | null; active: boolean; ready: boolean; catalog: object | null; dialog: object | null;
    draft: InvoiceTemplateDraft | null;
    inputs: { services: readonly Service[]; doctors: readonly { id: number; name: string }[]; disabled: boolean; allowManual: boolean; evidence: typeof evidence } | null
  }>({ owner: null, active: false, ready: false, catalog: null, dialog: null, draft: null, inputs: null });
  const [read, setRead] = useState<{ owner: object; retry: number; templates: SpecialtyTemplate[] } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [toothDialog, setToothDialog] = useState<{ owner: object; draft: InvoiceTemplateDraft; catalog: object } | null>(null);
  useLayoutEffect(() => {
    lifetime.current = { owner, active: true, ready: false, catalog: null, dialog: null, draft: null, inputs: null };
    return () => { if (lifetime.current.owner === owner) lifetime.current.active = false; };
  }, [owner]);
  useLayoutEffect(() => { lifetime.current.dialog = null; setToothDialog(null); }, [owner, draft, read, disabled]);
  useLayoutEffect(() => { lifetime.current.draft = draft; lifetime.current.inputs = { services, doctors, disabled, allowManual, evidence }; }, [owner, draft, services, doctors, disabled, allowManual, evidence]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current.ready = false; lifetime.current.catalog = null; onCatalogReady(false); setError(false); setRead(null);
    void fetch("/api/plan-templates", { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload: unknown = await response.json().catch(() => null);
      if (lifetime.current.owner !== owner || !lifetime.current.active || controller.signal.aborted) return;
      const templates = response.ok && !response.redirected ? readInvoiceTemplateCatalog(payload) : null;
      if (!templates) { setError(true); return; }
      const snapshot = { owner, retry, templates };
      lifetime.current.ready = true; lifetime.current.catalog = snapshot; setRead(snapshot);
      onCatalogReady(!lifetime.current.draft || templates.some(one => one.id === lifetime.current.draft?.template.id && JSON.stringify(one) === JSON.stringify(lifetime.current.draft.template)));
    }).catch(() => { if (lifetime.current.owner === owner && lifetime.current.active && !controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [owner, retry, onCatalogReady]);
  const templates = read?.owner === owner && read.retry === retry ? read.templates : null;
  const editable = () => lifetime.current.owner === owner && lifetime.current.active && lifetime.current.ready && lifetime.current.catalog === read && lifetime.current.draft === draft && lifetime.current.inputs !== null && lifetime.current.inputs.services === services && lifetime.current.inputs.doctors === doctors
    && lifetime.current.inputs.disabled === false && templates !== null && !disabled;
  const catalogChanged = !!draft && !!templates && !templates.some(one => one.id === draft.template.id && JSON.stringify(one) === JSON.stringify(draft.template));
  const selection = draft?.selection;
  const template = draft?.template;
  const update = (next: InvoiceTemplateSelection) => {
    if (!editable() || !template || catalogChanged) return;
    onChange({ template, selection: { ...next, version: undefined } });
  };
  const site = (stepKey: string, toothCode: number | null) => selection?.sites?.find(one => siteKey(one.stepKey, one.toothCode) === siteKey(stepKey, toothCode));
  const setSite = (stepKey: string, toothCode: number | null, patch: Partial<Site>) => {
    if (!selection) return;
    const next = { ...site(stepKey, toothCode), ...patch, stepKey, toothCode };
    update({ ...selection, sites: [...(selection.sites ?? []).filter(one => siteKey(one.stepKey, one.toothCode) !== siteKey(stepKey, toothCode)), next] });
  };
  const choose = (id: string) => {
    if (!editable()) return;
    if (!id) { if (!allowManual || lifetime.current.inputs?.allowManual !== true) return; onChange(null); onCatalogReady(true); return; }
    const chosen = templates?.find(one => one.id === id);
    if (!chosen) return;
    onCatalogReady(true);
    onChange({ template: chosen, selection: {
      templateId: chosen.id, teeth: [], doctorId: null, sites: [],
      steps: chosen.steps.map(step => {
        const options = services.filter(one => one.category === step.category);
        // The selected numeric identity is sent explicitly, never a name-based server guess.
        const preferred = options.find(one => one.name === step.preferredService);
        return { key: step.key, include: !step.optional, serviceId: preferred?.id ?? options[0]?.id ?? null };
      }),
    } });
  };
  return <section aria-label="اختيار قالب العلاج للفاتورة" className="mb-3 rounded-xl border border-sky-200 bg-sky-50/30 p-3">
    <p className="text-xs text-slate-600">القالب يجهّز بنود الفاتورة وجلساتها للمراجعة. لا يُحفظ شيء حتى اعتماد الفاتورة، ولا تُنشأ موافقة سريرية أو دفعة تلقائيًا.</p>
    {!templates ? <p role={error ? "alert" : "status"} className="mt-2 text-sm">
      {error ? "تعذّر التحقق من قوالب العلاج؛ لم تُستخدم قائمة بديلة." : "جارٍ تحميل قوالب العلاج…"}
      {error ? <button type="button" onClick={() => { if (lifetime.current.owner === owner && lifetime.current.active && !disabled) { lifetime.current.ready = false; lifetime.current.catalog = null; onCatalogReady(false); setRetry(value => value + 1); } }} className="mr-2 min-h-11 underline">إعادة تحميل القوالب</button> : null}
    </p> : <label className="mt-2 block text-xs font-bold">قالب العلاج
      <select aria-label="قالب العلاج" value={catalogChanged ? "" : selection?.templateId ?? ""} disabled={disabled}
        onChange={event => choose(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border bg-white px-3">
        <option value="" disabled={!allowManual}>بدون قالب — بنود يدوية</option>
        {templates.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
      </select>
    </label>}
    {!allowManual ? <p role="status" data-testid="invoice-template-retained-origin" className="mt-2 text-xs text-amber-800">يوجد طلب قالب محفوظ للتحقق. لا يمكن تحويله إلى فاتورة يدوية؛ أعد نفس الطلب أو عدّل القالب مع إبقاء مفتاحه الأصلي.</p> : null}
    {catalogChanged ? <p role="alert" className="mt-2 text-xs text-amber-800">تغيّر تعريف القالب. اختر القالب الحالي صراحةً ثم راجع مبلغه وجلساته من جديد.</p> : null}
    {templates ? <button type="button" disabled={disabled} onClick={() => { if (editable()) { lifetime.current.ready = false; lifetime.current.catalog = null; onCatalogReady(false); setRetry(value => value + 1); } }}
      className="mt-2 min-h-11 rounded-lg border px-3 text-xs">إعادة قراءة دليل القوالب</button> : null}
    {template && selection ? <fieldset disabled={disabled || !templates || catalogChanged} className="mt-3 space-y-3">
      <p className="break-words text-xs text-slate-600">{template.description}</p>
      {template.steps.some(step => step.perTooth && selection.steps.some(one => one.key === step.key && one.include)) ? <div>
        <p className="mb-1 text-xs font-bold">أسنان خطوات القالب</p>
        <button type="button" data-testid="invoice-template-teeth" aria-haspopup="dialog"
          onClick={() => { if (editable() && draft && read) { const dialog = { owner, draft, catalog: read }; lifetime.current.dialog = dialog; setToothDialog(dialog); } }}
          className="min-h-11 rounded-xl border border-navy-300 bg-white px-3 text-xs font-bold">اختيار أسنان القالب من المخطط</button>
        <p className="mt-1 text-xs" data-testid="invoice-template-selected-teeth">{selection.teeth.length ? `الأسنان المختارة: ${selection.teeth.join("، ")}` : "لم تُحدد أسنان بعد."}</p>
      </div> : null}
      <label className="block text-xs font-bold">طبيب بنود القالب
        <select aria-label="طبيب بنود القالب" value={selection.doctorId ?? ""}
          onChange={event => update({ ...selection, doctorId: event.target.value ? Number(event.target.value) : null,
            sites: selection.sites?.map(one => ({ ...one, caseId: null })) })}
          className="mt-1 min-h-11 w-full rounded-xl border bg-white px-3">
          <option value="">بدون تحديد</option>
          {doctors.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
        </select>
      </label>
      {template.steps.map(step => {
        const chosen = selection.steps.find(one => one.key === step.key);
        const options = services.filter(one => one.category === step.category);
        const selectedService = options.find(one => one.id === chosen?.serviceId);
        const mode = invoiceToothMode(selectedService?.category);
        const teeth = step.perTooth ? selection.teeth : [null];
        return <div key={step.key} className="rounded-xl border bg-white p-3">
          <label className="text-sm font-bold">
            {step.optional ? <input type="checkbox" aria-label={`تضمين ${step.title}`} checked={chosen?.include === true}
              onChange={event => update({ ...selection, steps: selection.steps.map(one => one.key === step.key ? { ...one, include: event.target.checked } : one),
                sites: selection.sites?.filter(one => one.stepKey !== step.key) })} /> : null} {step.title}
          </label>
          {chosen?.include ? <>
            <select aria-label={`خدمة ${step.title}`} value={chosen.serviceId ?? ""}
              onChange={event => update({ ...selection, steps: selection.steps.map(one => one.key === step.key ? { ...one, serviceId: Number(event.target.value) || null } : one),
                sites: selection.sites?.filter(one => one.stepKey !== step.key) })}
              className="mt-2 min-h-11 w-full rounded-xl border bg-white px-3">
              <option value="">اختر الخدمة</option>
              {options.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
            </select>
            {selectedService ? <p className="mt-1 break-words text-xs font-bold" aria-label={`الخدمة المختارة ${step.title}`}>{selectedService.name}</p> : null}
            <p className="mt-1 break-words text-xs text-slate-500">الجلسات المقترحة: {step.sessions.map(one => `${one.title} (${one.minutes} دقيقة، بعد ${one.afterDays} يوم)`).join("؛ ")}. الجدول النهائي يظهر في المعاينة.</p>
            {mode === "multi_tooth_episode" ? <label className="mt-2 flex min-h-11 items-center gap-2 text-xs">
              <input type="checkbox" aria-label={`حلقة ${step.title}`} checked={selection.teeth.length > 0 && selection.teeth.every(tooth => {
                const group = site(step.key, tooth)?.episodeTeeth;
                return group?.length === selection.teeth.length && group.every((one,index) => one === selection.teeth[index]);
              })} onChange={event => update({ ...selection,
                sites: [...(selection.sites ?? []).filter(one => one.stepKey !== step.key), ...selection.teeth.map(toothCode => ({
                  ...site(step.key, toothCode), stepKey: step.key, toothCode,
                  episodeTeeth: event.target.checked ? [...selection.teeth] : null, caseId: null,
                }))],
              })} />
              أؤكد أن أسنان {selection.teeth.join("، ")} تشكّل حلقة واحدة لهذه الخطوة — دون استنتاج الدعامات
            </label> : null}
            {teeth.map(toothCode => {
              const selectedSite = site(step.key, toothCode);
              const key = invoiceTemplateRowKey(step.key, toothCode);
              const preview = evidence?.byRow.get(key);
              return <div key={key} className="mt-2 rounded-lg border border-slate-100 p-2 text-xs">
                <p className="font-bold">{toothCode === null ? step.title : `سن ${toothCode}`}</p>
                {mode === "arch" || mode === "region" && toothCode === null ? <label className="mt-1 block">نطاق خطوة القالب
                  <select aria-label={`نطاق ${step.title}`} value={selectedSite?.scope ?? ""}
                    onChange={event => setSite(step.key, toothCode, { scope: event.target.value || null, caseId: null })}
                    className="mt-1 min-h-11 w-full rounded-lg border bg-white px-2">
                    <option value="">اختر النطاق صراحةً</option>
                    {allowedScopes(mode).map(scope => <option key={scope} value={scope}>{SITE_SCOPE_LABEL[scope]}</option>)}
                  </select>
                </label> : null}
                {mode === "tooth_surfaces" ? <label className="mt-1 block">الأسطح الاختيارية
                  <input aria-label={`أسطح ${step.title} للسن ${toothCode}`} value={selectedSite?.surfaces ?? ""}
                    onChange={event => setSite(step.key, toothCode, { surfaces: event.target.value, caseId: null })}
                    maxLength={5} placeholder="MODBL" className="mt-1 min-h-11 w-full rounded-lg border px-2" />
                </label> : null}
                {preview?.case?.options.length ? <label className="mt-1 block">الحالة المطابقة
                  <select aria-label={`حالة ${step.title} ${toothCode ?? "النطاق"}`} value={selectedSite?.caseId ?? ""}
                    onChange={event => {
                      if (lifetime.current.owner !== owner || lifetime.current.inputs?.evidence !== evidence) return;
                      const id = event.target.value ? Number(event.target.value) : null;
                      if (id !== null && !preview.case?.options.some(one => one.id === id)) return;
                      setSite(step.key, toothCode, { caseId: id });
                    }} className="mt-1 min-h-11 w-full rounded-lg border bg-white px-2">
                    <option value="">راجع قرار المعاينة</option>
                    {preview.case.options.map(one => <option key={one.id} value={one.id}>{one.title} — #{one.id}</option>)}
                  </select>
                </label> : null}
                {preview?.refusalMessage ? <p role="alert" className="mt-1 text-amber-800">{preview.refusalMessage}</p> : null}
              </div>;
            })}
          </> : null}
        </div>;
      })}
    </fieldset> : null}
    {toothDialog && toothDialog.owner === owner && toothDialog.draft === draft && toothDialog.catalog === read && templates && template && selection && !disabled ?
      <ToothSelectionDialog key={`${patientId}:${template.id}`} patientId={patientId} mode="per_tooth_episode"
        serviceName={`أسنان قالب ${template.name}`} initial={{ teeth: selection.teeth, surfaces: "", scope: null }}
        onConfirm={chosen => {
          if (!editable() || lifetime.current.dialog !== toothDialog || toothDialog.draft !== draft || toothDialog.catalog !== lifetime.current.catalog) return;
          update({ ...selection, teeth: [...new Set(chosen.teeth)].sort((a,b) => a-b), sites: [] }); lifetime.current.dialog = null; setToothDialog(null);
        }} onCancel={() => { if (lifetime.current.owner === owner && lifetime.current.dialog === toothDialog) { lifetime.current.dialog = null; setToothDialog(null); } }} /> : null}
  </section>;
}
