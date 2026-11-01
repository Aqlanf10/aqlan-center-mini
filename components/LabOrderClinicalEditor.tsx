"use client";

import { useEffect, useRef, useState } from "react";
import { parseLabTeeth, WORK_TYPES, type LabOrder } from "@/lib/lab";
import { labShadeSelectionForCode, parseLabShadeSpecification } from "@/lib/lab-shades";
import { labClinicalEditProblem, type LabClinicalSnapshot } from "@/lib/lab-clinical-edit";
import { LabShadeSelector } from "./LabShadeSelector";
import { LabDentalChart } from "./LabDentalChart";

interface Party { id: number; name: string; phone: string | null; kind: string; isActive: boolean }
const clinicalSnapshot = (order: LabOrder): LabClinicalSnapshot => ({ doctorId: order.doctorId ?? null, workType: order.workType,
  toothNumbers: order.toothNumbers ?? null, shade: order.shade ?? null, shadeSpecification: order.shadeSpecification ?? null,
  partyId: order.partyId ?? null, labName: order.labName, labPhone: order.labPhone ?? null });

/** A separate clinical correction, never an implicit repricing or historical role migration. */
export function LabOrderClinicalEditor({ order, onClose, onSaved }: {
  order: LabOrder; onClose: () => void; onSaved: () => void;
}) {
  const [clinical, setClinical] = useState(() => clinicalSnapshot(order));
  const [doctors, setDoctors] = useState<Party[]>([]);
  const [labs, setLabs] = useState<Party[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    active.current = true; dialog.current?.showModal();
    const controller = new AbortController();
    void (async () => {
      try {
        const results = await Promise.all(["doctor", "lab"].map(async kind => {
          const response = await fetch(`/api/parties?kind=${kind}`, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("directory");
          const data: unknown = await response.json();
          if (!Array.isArray(data)) throw new Error("directory");
          return data.filter((item): item is Party => !!item && typeof item === "object"
            && Number.isSafeInteger(item.id) && item.id > 0 && typeof item.name === "string"
            && item.kind === kind && item.isActive === true && (item.phone === null || typeof item.phone === "string"));
        }));
        if (active.current && !controller.signal.aborted) { setDoctors(results[0]); setLabs(results[1]); }
      } catch { if (active.current && !controller.signal.aborted) setError("تعذر تحميل دليل الأطباء والمعامل؛ أغلق النافذة وأعد المحاولة."); }
    })();
    return () => { active.current = false; controller.abort(); };
  }, []);
  const selected = Object.keys(parseLabTeeth(clinical.toothNumbers)).map(Number);

  const set = <K extends keyof typeof clinical>(key: K, value: (typeof clinical)[K]) => setClinical(current => ({ ...current, [key]: value }));
  async function save() {
    if (pending.current || order.shadeSpecificationWarning) return;
    if ((!clinical.doctorId && order.doctorId != null) || !clinical.workType.trim()) { setError("لا تُزل الطبيب المحفوظ؛ حدّد نوع العمل قبل الحفظ."); return; }
    const problem = labClinicalEditProblem(clinical, clinicalSnapshot(order));
    if (problem) { setError(problem); return; }
    const shades = parseLabShadeSpecification(clinical.shadeSpecification, selected);
    if (!shades.ok) { setError(shades.error); return; }
    if (clinical.shade && clinical.shade !== order.shade && !labShadeSelectionForCode(clinical.shade)) {
      setError("اختر اللون الجديد من دليل VITA؛ اللون القديم لا يُحوّل تلقائيًا."); return;
    }
    pending.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/lab/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_clinical", expectedClinical: clinicalSnapshot(order), clinical }) });
      const result = await response.json();
      if (!active.current) return;
      if (!response.ok) { setError(result.message || "تعذر تصحيح الإرسالية."); return; }
      onSaved();
    } catch { if (active.current) setError("تعذر التأكد من الحفظ؛ أغلق النافذة وأعد تحميل الإرسالية قبل المحاولة."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const inputClass = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2";
  return <dialog ref={dialog} aria-labelledby="lab-clinical-editor-title" dir="rtl"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}
    className="max-h-[90vh] w-[min(95vw,64rem)] rounded-2xl p-5 backdrop:bg-black/40">
    <h2 id="lab-clinical-editor-title" className="mb-3 text-lg font-bold">تصحيح بيانات الإرسالية #{order.id}</h2>
    <p role="note" className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">تغيير نوع العمل أو الأسنان لا يغيّر المبلغ المالي المحفوظ؛ راجع التكلفة من الربط المحاسبي بشكل منفصل. تغيير المعمل عند وجود تكلفة أو التزام مالي محظور هنا. تغيير الطبيب عند وجود تكلفة أو التزام أو فاتورة مرتبطة بالزيارة محظور حفاظًا على العمولات والتاريخ المالي؛ يلزم مسار تصحيح مالي منفصل. لا تُحوّل الأدوار أو الألوان القديمة تلقائيًا. بعد الحفظ أعد إصدار الاستمارة للمعمل.</p>
    {!order.doctorId && <p role="status" className="mb-3 text-sm text-amber-800">الطبيب غير مسجل في الإرسالية القديمة؛ يمكن تصحيح بقية البيانات دون نسبتها تلقائيًا لطبيب. تبقى الإرسالية بحاجة إلى مراجعة الطبيب.</p>}
    <fieldset disabled={busy || !!order.shadeSpecificationWarning} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>الطبيب المعالج<select aria-label="طبيب تصحيح الإرسالية" className={inputClass} value={clinical.doctorId ?? ""} onChange={event => set("doctorId", event.target.value ? Number(event.target.value) : null)}>
          <option value="">اختر الطبيب المعالج</option>
          {order.doctorId && !doctors.some(item => item.id === order.doctorId) && <option value={order.doctorId}>{order.doctorName || "الطبيب المحفوظ"} — بيانات محفوظة؛ قد يكون غير نشط</option>}
          {doctors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>المعمل<select aria-label="معمل تصحيح الإرسالية" className={inputClass} value={clinical.partyId === order.partyId ? "current" : String(clinical.partyId)} onChange={event => {
          if (event.target.value === "current") { setClinical(current => ({ ...current, partyId: order.partyId, labName: order.labName, labPhone: order.labPhone })); return; }
          const lab = labs.find(item => item.id === Number(event.target.value));
          if (lab) setClinical(current => ({ ...current, partyId: lab.id, labName: lab.name, labPhone: lab.phone }));
        }}>
          <option value="current">المعمل المحفوظ: {order.labName}</option>
          {labs.filter(item => item.id !== order.partyId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="sm:col-span-2">نوع العمل<select aria-label="نوع العمل في التصحيح" className={inputClass} value={clinical.workType} onChange={event => set("workType", event.target.value)}>
          {!WORK_TYPES.includes(order.workType) && <option value={order.workType}>المحفوظ: {order.workType}</option>}
          {WORK_TYPES.filter(work => work !== "أخرى (مخصص)").map(work => <option key={work} value={work}>{work}</option>)}
        </select></label>
      </div>
      {!clinical.toothNumbers && order.toothCode && <p className="text-sm text-amber-900">سن الزيارة المرجعي: {order.toothCode}. اختره صراحةً من المخطط مع دوره قبل إضافة تفاصيل اللون.</p>}
      <LabDentalChart value={clinical.toothNumbers ?? ""} workType={clinical.workType} onChange={value => set("toothNumbers", value || null)} />
      <label className="block">نص الأسنان والأدوار المحفوظة<input aria-label="أسنان الإرسالية للتصحيح" className={inputClass} value={clinical.toothNumbers ?? ""} onChange={event => set("toothNumbers", event.target.value || null)} /></label>
      <LabShadeSelector value={clinical.shadeSpecification} onChange={value => set("shadeSpecification", value)} selectedTeeth={selected}
        globalShade={clinical.shade ?? ""} onGlobalShadeChange={value => set("shade", value || null)} disabled={busy} />
    </fieldset>
    {order.shadeSpecificationWarning && <p role="alert">{order.shadeSpecificationWarning}</p>}
    {error && <p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex gap-2">
      <button type="button" disabled={busy || !!order.shadeSpecificationWarning} onClick={() => void save()} className="rounded-lg bg-navy-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "جارٍ الحفظ…" : "حفظ تصحيح الإرسالية"}</button>
      <button type="button" disabled={busy} onClick={onClose} className="rounded-lg border px-4 py-2">إلغاء وإغلاق</button>
    </div>
  </dialog>;
}
