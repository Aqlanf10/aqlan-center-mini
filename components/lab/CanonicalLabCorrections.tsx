"use client";

import { useState } from "react";
import {
  LAB_IMPRESSION_LABEL, LAB_PRIORITY_LABEL, LAB_TOOTH_ROLE_META, WORK_TYPES, parseLabTeeth,
  type LabImpressionType, type LabOrderClinicalDTO, type LabOrderPriority,
} from "@/lib/lab";
import { LAB_PRESCRIPTION_SHADES, labPrescriptionVersion } from "@/lib/lab-prescription-input";
import { LAB_SHADE_CODES, labShadeSelectionForCode, type LabShadeSpecification } from "@/lib/lab-shades";

/**
 * تصحيحات الإرسالية في اللوحة الموحّدة (M2 slice 69) — لمن يملك clinical.visits.document.
 *
 * كل حفظ يرسل ما رأته الشاشة: نسخة المواصفات (استكمال الإرسالية)، أو لقطة البيانات
 * السريرية (التصحيح)، أو مواصفات الألوان (الألوان). إن تغيّر شيء من جهاز آخر يرفض الخادم
 * ويُعاد تحميل اللوحة؛ لا يُكتب فوق عمل غيرك. الطبيب والمختبر لا يتغيران متى ارتبط
 * بالإرسالية مال — يقرر ذلك الخادم ويشرح السبب.
 */
type Directory = { labParties?: { id: number; name: string; phone?: string | null }[]; doctors?: { id: number; name: string }[] };
const ROLES = Object.values(LAB_TOOTH_ROLE_META).filter(meta => meta.role !== "denture_tooth" && meta.role !== "clasp_abutment");
const BODY_SHADES = LAB_SHADE_CODES.vita_classical;

function teethOf(raw: string | null | undefined): number[] {
  return Object.keys(parseLabTeeth(raw ?? "")).map(Number);
}

export function CanonicalLabCorrections({ order, directory, onChanged }: { order: LabOrderClinicalDTO; directory: Directory; onChanged: () => void }) {
  const [panel, setPanel] = useState<null | "prescription" | "clinical" | "shade">(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Prescription (needed only).
  const [partyId, setPartyId] = useState(order.partyId ? String(order.partyId) : "");
  const [teeth, setTeeth] = useState(teethOf(order.toothNumbers).join(", ") || (order.toothCode ? String(order.toothCode) : ""));
  const [role, setRole] = useState("Crown");
  const [shade, setShade] = useState(order.shade ?? "");
  const [stump, setStump] = useState(order.stumpShade ?? "");
  const [due, setDue] = useState(order.dueDate);
  const [impression, setImpression] = useState<LabImpressionType>(order.impressionType ?? "physical");
  const [priority, setPriority] = useState<LabOrderPriority>(order.priority ?? "normal");

  // Clinical correction.
  const snapshot = {
    doctorId: order.doctorId ?? null, workType: order.workType, toothNumbers: order.toothNumbers ?? null, shade: order.shade ?? null,
    shadeSpecification: (order.shadeSpecification ?? null) as LabShadeSpecification | null, partyId: order.partyId ?? null,
    labName: order.labName, labPhone: order.labPhone ?? null,
  };
  const [workType, setWorkType] = useState(order.workType);
  const [clinicalTeeth, setClinicalTeeth] = useState(order.toothNumbers ?? "");
  const [doctorId, setDoctorId] = useState(order.doctorId ? String(order.doctorId) : "");
  const [labId, setLabId] = useState(order.partyId ? String(order.partyId) : "");

  // Shade specification (body shade per tooth).
  const selected = teethOf(order.toothNumbers).length ? teethOf(order.toothNumbers) : order.toothCode ? [order.toothCode] : [];
  const [bodies, setBodies] = useState<Record<number, string>>(() => Object.fromEntries(
    (order.shadeSpecification?.teeth ?? []).map(tooth => [tooth.toothCode, tooth.body?.code ?? ""])));

  async function send(body: Record<string, unknown>) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/lab/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر الحفظ."); if (response.status === 409) onChanged(); return; }
      setPanel(null); onChanged();
    } catch { setMessage("تعذّر الاتصال بالخادم."); } finally { setBusy(false); }
  }

  function savePrescription(dispatch: boolean) {
    const toothNumbers = teeth.split(/[,،\s]+/).filter(Boolean).map(code => `${code}(${role})`).join(",");
    void send({
      action: "complete_prescription", dispatch, expected: labPrescriptionVersion(order),
      prescription: { partyId: partyId ? Number(partyId) : null, shade, stumpShade: stump, toothNumbers, dueDate: due, impressionType: impression, priority },
    });
  }
  function saveClinical() {
    const lab = (directory.labParties ?? []).find(party => String(party.id) === labId);
    const labChanged = labId !== (order.partyId ? String(order.partyId) : "");
    void send({
      action: "update_clinical", expectedClinical: snapshot,
      clinical: {
        ...snapshot, workType, toothNumbers: clinicalTeeth.trim() || null, doctorId: doctorId ? Number(doctorId) : null,
        ...(labChanged && lab ? { partyId: lab.id, labName: lab.name, labPhone: lab.phone ?? null } : {}),
      },
    });
  }
  function saveShade() {
    const teethShades = selected.filter(code => bodies[code]).map(code => ({ toothCode: code, cervical: null, body: labShadeSelectionForCode(bodies[code]), incisal: null }));
    void send({ action: "update_shade", expectedShadeSpecification: snapshot.shadeSpecification, shadeSpecification: teethShades.length ? { version: 1, teeth: teethShades } : null });
  }

  const field = "min-h-10 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-xs";
  const tab = (key: "prescription" | "clinical" | "shade", label: string) => (
    <button type="button" onClick={() => { setPanel(panel === key ? null : key); setMessage(null); }} aria-expanded={panel === key} data-correction={key}
      className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-900">{label}</button>
  );
  return (
    <div className="mt-2 space-y-2" data-testid="lab-corrections">
      <div className="flex flex-wrap gap-2">
        {order.status === "needed" ? tab("prescription", "استكمال الإرسالية") : null}
        {order.status !== "cancelled" ? tab("clinical", "تصحيح البيانات") : null}
        {order.status !== "cancelled" && selected.length ? tab("shade", "الألوان") : null}
      </div>
      {panel === "prescription" ? (
        <div className="grid gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-2" data-testid="lab-prescription-form">
          <label className="text-xs">المختبر
            <select className={field} value={partyId} onChange={event => setPartyId(event.target.value)} data-testid="rx-party">
              <option value="">اختر من الدليل</option>
              {(directory.labParties ?? []).map(party => <option key={party.id} value={party.id}>{party.name}</option>)}
            </select>
          </label>
          <label className="text-xs">الأسنان (FDI)
            <input className={field} dir="ltr" value={teeth} onChange={event => setTeeth(event.target.value)} data-testid="rx-teeth" />
          </label>
          <label className="text-xs">دور الأسنان
            <select className={field} value={role} onChange={event => setRole(event.target.value)}>
              {ROLES.map(meta => <option key={meta.role} value={meta.englishLabel}>{meta.label}</option>)}
            </select>
          </label>
          <label className="text-xs">اللون
            <select className={field} value={shade} onChange={event => setShade(event.target.value)} data-testid="rx-shade">
              <option value="">اختر</option>
              {LAB_PRESCRIPTION_SHADES.map(code => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="text-xs">لون الدعامة (اختياري)
            <input className={field} dir="ltr" value={stump} maxLength={10} onChange={event => setStump(event.target.value)} />
          </label>
          <label className="text-xs">موعد التسليم
            <input type="date" dir="ltr" className={field} value={due} onChange={event => setDue(event.target.value)} />
          </label>
          <label className="text-xs">نوع الطبعة
            <select className={field} value={impression} onChange={event => setImpression(event.target.value as LabImpressionType)}>
              {Object.entries(LAB_IMPRESSION_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs">الأولوية
            <select className={field} value={priority} onChange={event => setPriority(event.target.value as LabOrderPriority)}>
              {Object.entries(LAB_PRIORITY_LABEL).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="button" disabled={busy} onClick={() => savePrescription(false)} className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold disabled:opacity-50">حفظ مسودة</button>
            <button type="button" disabled={busy} onClick={() => savePrescription(true)} data-testid="rx-dispatch" className="min-h-10 rounded-xl bg-navy-900 px-3 text-xs font-bold text-white disabled:opacity-50">حفظ وتسجيل الإرسال</button>
          </div>
        </div>
      ) : null}
      {panel === "clinical" ? (
        <div className="grid gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-2" data-testid="lab-clinical-form">
          <label className="text-xs">نوع العمل
            <select className={field} value={workType} onChange={event => setWorkType(event.target.value)} data-testid="fix-work">
              {[order.workType, ...WORK_TYPES.filter(work => work !== order.workType && work !== "أخرى (مخصص)")].map(work => <option key={work} value={work}>{work}</option>)}
            </select>
          </label>
          <label className="text-xs">الأسنان (FDI)
            <input className={field} dir="ltr" value={clinicalTeeth} onChange={event => setClinicalTeeth(event.target.value)} data-testid="fix-teeth" />
          </label>
          <label className="text-xs">الطبيب المعالج
            <select className={field} value={doctorId} onChange={event => setDoctorId(event.target.value)}>
              {order.doctorId ? null : <option value="">—</option>}
              {(directory.doctors ?? []).map(doctor => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
            </select>
          </label>
          <label className="text-xs">المختبر
            <select className={field} value={labId} onChange={event => setLabId(event.target.value)}>
              {order.partyId ? null : <option value="">—</option>}
              {(directory.labParties ?? []).map(party => <option key={party.id} value={party.id}>{party.name}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={saveClinical} data-testid="fix-save" className="min-h-10 rounded-xl bg-navy-900 px-3 text-xs font-bold text-white disabled:opacity-50 sm:col-span-2">حفظ التصحيح</button>
        </div>
      ) : null}
      {panel === "shade" ? (
        <div className="space-y-2 rounded-xl border border-slate-200 p-2" data-testid="lab-shade-form">
          {selected.map(code => (
            <label key={code} className="flex items-center gap-2 text-xs">
              <span dir="ltr" className="w-8">{code}</span>
              <select className={field} value={bodies[code] ?? ""} onChange={event => setBodies(current => ({ ...current, [code]: event.target.value }))} data-shade-tooth={code}>
                <option value="">بلا لون</option>
                {BODY_SHADES.map(shadeCode => <option key={shadeCode} value={shadeCode}>{shadeCode}</option>)}
              </select>
            </label>
          ))}
          <button type="button" disabled={busy} onClick={saveShade} data-testid="shade-save" className="min-h-10 rounded-xl bg-navy-900 px-3 text-xs font-bold text-white disabled:opacity-50">حفظ الألوان</button>
        </div>
      ) : null}
      {message ? <p role="alert" className="text-xs text-red-800">{message}</p> : null}
    </div>
  );
}
