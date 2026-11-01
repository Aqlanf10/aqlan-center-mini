"use client";

import { useState } from "react";
import { ALL_TEETH } from "@/lib/dental";
import {
  LAB_SHADE_CODES, LAB_SHADE_GUIDES, LAB_SHADE_GUIDE_LABELS, LAB_SHADE_ZONES, LAB_SHADE_ZONE_LABELS,
  labShadeSelectionForCode, type LabShadeGuide, type LabShadeSelection, type LabShadeSpecification, type LabShadeZone,
} from "@/lib/lab-shades";

function ShadeFields({ label, value, onChange, disabled }: {
  label: string; value: LabShadeSelection | null; onChange: (value: LabShadeSelection | null) => void; disabled: boolean;
}) {
  const [pendingGuide, setPendingGuide] = useState<LabShadeGuide>(value?.guide ?? "vita_classical");
  const guide = value?.guide ?? pendingGuide;
  return <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
    <label className="text-xs">دليل اللون — {label}
      <select aria-label={`دليل اللون — ${label}`} disabled={disabled} value={guide}
        onChange={event => { setPendingGuide(event.target.value as LabShadeGuide); onChange(null); }}
        className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2" dir="ltr">
        {LAB_SHADE_GUIDES.map(item => <option key={item} value={item}>{LAB_SHADE_GUIDE_LABELS[item]}</option>)}
      </select>
    </label>
    <label className="text-xs">درجة اللون — {label}
      <select aria-label={`درجة اللون — ${label}`} disabled={disabled} value={value?.code ?? ""}
        onChange={event => onChange(event.target.value ? { guide, code: event.target.value } : null)}
        className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2" dir="ltr">
        <option value="">غير محدد</option>
        {LAB_SHADE_CODES[guide].map(code => <option key={code} value={code}>{code}</option>)}
      </select>
    </label>
  </div>;
}

export interface LabShadeSelectorProps {
  value: LabShadeSpecification | null;
  onChange: (value: LabShadeSpecification | null) => void;
  selectedTeeth: readonly number[];
  globalShade: string;
  onGlobalShadeChange: (value: string) => void;
  disabled?: boolean;
  globalShadeReadOnly?: boolean;
}

/** Explicit clinician selections only; never guesses a zone from a global shade. */
export function LabShadeSelector({ value, onChange, selectedTeeth, globalShade, onGlobalShadeChange, disabled = false, globalShadeReadOnly = false }: LabShadeSelectorProps) {
  const globalSelection = labShadeSelectionForCode(globalShade);
  const codes = [...new Set([...selectedTeeth, ...(value?.teeth.map(item => item.toothCode) ?? [])])]
    .filter(code => ALL_TEETH.includes(code)).sort((a, b) => a - b);
  const setZone = (toothCode: number, zone: LabShadeZone, selection: LabShadeSelection | null) => {
    const existing = value?.teeth.find(item => item.toothCode === toothCode)
      ?? { toothCode, cervical: null, body: null, incisal: null };
    const next = { ...existing, [zone]: selection };
    const teeth = (value?.teeth ?? []).filter(item => item.toothCode !== toothCode);
    if (LAB_SHADE_ZONES.some(key => next[key] !== null)) teeth.push(next);
    onChange(teeth.length ? { version: 1, teeth: teeth.sort((a, b) => a.toothCode - b.toothCode) } : null);
  };
  return <section aria-label="تحديد ألوان الأسنان للمعمل" className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3" dir="rtl">
    <h4 className="font-bold text-navy-900">اللون العام وتفاصيل لون كل سن</h4>
    <p className="text-xs text-slate-600">اختر الدليل والرمز من دليل الألوان الفعلي. ألوان الشاشة ليست مرجعًا سريريًا. التفاصيل لكل منطقة اختيارية ولا تُنسخ تلقائيًا من اللون العام.</p>
    <ShadeFields label="اللون العام" value={globalSelection} disabled={disabled || globalShadeReadOnly}
      onChange={selection => onGlobalShadeChange(selection?.code ?? "")} />
    {globalShade && !globalSelection ? <p role="status" className="text-xs text-amber-800">
      اللون السابق محفوظ كما هو: <b dir="ltr">{globalShade}</b>. لا يطابق الدليلين المتاحين؛ راجعه ولا يُحوّل تلقائيًا.
    </p> : null}
    {codes.length === 0 ? <p className="text-xs text-slate-500">حدد الأسنان لإدخال لون عنق وجسم وحافة كل سن.</p> : null}
    {codes.map(toothCode => {
      const row = value?.teeth.find(item => item.toothCode === toothCode);
      const stale = !selectedTeeth.includes(toothCode);
      return <fieldset key={toothCode} disabled={disabled} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
        <legend className="px-1 font-bold text-navy-900">السن <span dir="ltr">{toothCode}</span></legend>
        {stale ? <div role="alert" className="text-xs text-amber-800">هذا السن لم يعد ضمن الإرسالية؛ راجع تفاصيل لونه قبل الحفظ.
          <button type="button" disabled={disabled} className="ms-2 min-h-11 underline" onClick={() => {
            const teeth = (value?.teeth ?? []).filter(item => item.toothCode !== toothCode);
            onChange(teeth.length ? { version: 1, teeth } : null);
          }}>إزالة تفاصيل هذا السن</button>
        </div> : null}
        {LAB_SHADE_ZONES.map(zone => <ShadeFields key={zone} label={`${LAB_SHADE_ZONE_LABELS[zone]} — سن ${toothCode}`}
          value={row?.[zone] ?? null} disabled={disabled || stale} onChange={selection => setZone(toothCode, zone, selection)} />)}
      </fieldset>;
    })}
  </section>;
}
