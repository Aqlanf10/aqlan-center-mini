"use client";
import React, { useState } from 'react';
import { Language, ToothChartEntry, ToothStatus } from '../types/ortho';
import { tr } from '../i18n/translations';
import { FDI_NOTE_PRESETS } from '../data/clinicalQuickOptions';

interface FdiToothChartProps {
  chart: Record<string, ToothChartEntry>;
  lang: Language;
  readOnly?: boolean;
  onChange: (nextChart: Record<string, ToothChartEntry>) => void;
}

const STATUS_META: Record<ToothStatus, { ar: string; en: string; fill: string; stroke: string }> = {
  present: { ar: 'موجود وسليم', en: 'Present', fill: '#ffffff', stroke: '#94a3b8' },
  bracketed: { ar: 'مثبت عليه حاصرة', en: 'Bracketed', fill: '#ccfbf1', stroke: '#0f766e' },
  restored: { ar: 'ترميم / حشوة', en: 'Restored', fill: '#e0f2fe', stroke: '#0284c7' },
  caries: { ar: 'تسوس', en: 'Caries', fill: '#fef3c7', stroke: '#d97706' },
  unerupted: { ar: 'غير بازغ', en: 'Unerupted', fill: '#f1f5f9', stroke: '#64748b' },
  impacted: { ar: 'منطمر', en: 'Impacted', fill: '#ede9fe', stroke: '#7c3aed' },
  extract_planned: { ar: 'مخطط للخلع', en: 'Extract Planned', fill: '#fee2e2', stroke: '#dc2626' },
  missing: { ar: 'مفقود', en: 'Missing', fill: '#f8fafc', stroke: '#cbd5e1' },
};

const UPPER_QUAD = ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'];
const LOWER_QUAD = ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'];

export const FdiToothChart: React.FC<FdiToothChartProps> = ({ chart, lang, readOnly, onChange }) => {
  const [selectedFdi, setSelectedFdi] = useState<string>('11');

  const current = chart[selectedFdi] || { fdi: selectedFdi, status: 'present' as ToothStatus, note: '' };

  const updateTooth = (fdi: string, patch: Partial<ToothChartEntry>) => {
    if (readOnly) return;
    onChange({
      ...chart,
      [fdi]: { ...(chart[fdi] || { fdi, status: 'present', note: '' }), ...patch },
    });
  };

  const renderRow = (fdis: string[], isUpper: boolean) => (
    <div className="grid grid-cols-16 gap-1 min-w-[680px]" dir="ltr">
      {fdis.map((fdi, idx) => {
        const entry = chart[fdi] || { fdi, status: 'present' as ToothStatus, note: '' };
        const meta = STATUS_META[entry.status];
        const isSelected = selectedFdi === fdi;
        const isMidline = idx === 7;
        return (
          <button
            key={fdi}
            type="button"
            onClick={() => setSelectedFdi(fdi)}
            className={`group flex flex-col items-center p-1 rounded-md border transition-colors ${
              isMidline ? 'me-1.5' : ''
            } ${isSelected ? 'border-teal-700 bg-teal-50/70' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}
          >
            {isUpper && <span className="text-[11px] font-mono tabular-nums text-slate-600 mb-1">{fdi}</span>}
            <svg width="26" height="32" viewBox="0 0 26 32" className="shrink-0">
              <rect
                x="3"
                y={isUpper ? 8 : 3}
                width="20"
                height="20"
                rx="6"
                fill={meta.fill}
                stroke={isSelected ? '#0f766e' : meta.stroke}
                strokeWidth={isSelected ? 2 : 1.5}
                strokeDasharray={entry.status === 'unerupted' ? '3 2' : undefined}
              />
              {entry.status === 'missing' && (
                <path d="M6 6 L20 26 M20 6 L6 26" stroke="#94a3b8" strokeWidth="1.5" />
              )}
              {entry.status === 'bracketed' && (
                <rect x="9" y={isUpper ? 14 : 9} width="8" height="7" rx="1" fill="#0f766e" />
              )}
              {entry.note && <circle cx="20" cy="6" r="3" fill="#0284c7" />}
            </svg>
            {!isUpper && <span className="text-[11px] font-mono tabular-nums text-slate-600 mt-1">{fdi}</span>}
          </button>
        );
      })}
    </div>
  );

  const notedTeeth = Object.values(chart).filter((t) => t.note.trim() || t.status !== 'present');

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">
            {tr(lang, 'مخطط الأسنان التفاعلي (ترقيم FDI)', 'Interactive Dental Chart (FDI Notation)')}
          </h4>
          <p className="text-xs text-slate-500 mt-0.5">
            {tr(lang, 'انقر على أي سن لتحديد حالته السريرية وربط ملاحظة مخصصة به', 'Select any tooth to assign clinical status and tooth-specific notes')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
          {(['present', 'bracketed', 'restored', 'caries', 'impacted', 'extract_planned', 'missing'] as ToothStatus[]).map((st) => (
            <span key={st} className="inline-flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-sm border inline-block"
                style={{ backgroundColor: STATUS_META[st].fill, borderColor: STATUS_META[st].stroke }}
              />
              <span>{lang === 'ar' ? STATUS_META[st].ar : STATUS_META[st].en}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="space-y-2 border border-slate-100 rounded-lg p-3 bg-slate-50/40">
          {renderRow(UPPER_QUAD, true)}
          <div className="border-t border-slate-200 my-1" />
          {renderRow(LOWER_QUAD, false)}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-slate-100 items-start">
        <div className="md:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-900 font-mono tabular-nums">
              {tr(lang, `السن المحدد: FDI #${selectedFdi}`, `Selected Tooth: FDI #${selectedFdi}`)}
            </span>
            <span className="text-xs text-slate-500">
              {lang === 'ar' ? STATUS_META[current.status].ar : STATUS_META[current.status].en}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(STATUS_META) as ToothStatus[]).map((st) => (
              <button
                key={st}
                type="button"
                disabled={readOnly}
                onClick={() => updateTooth(selectedFdi, { status: st })}
                className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                  current.status === st
                    ? 'bg-teal-700 text-white border-teal-700 font-medium'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {lang === 'ar' ? STATUS_META[st].ar : STATUS_META[st].en}
              </button>
            ))}
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <label className="block text-xs font-medium text-slate-700">
                {tr(lang, `ملاحظة سريرية للسن #${selectedFdi}`, `Clinical Note for Tooth #${selectedFdi}`)}
              </label>
              {!readOnly && (
                <select
                  value=""
                  onChange={(e) => {
                    const idx = e.target.value;
                    if (!idx) return;
                    const preset = FDI_NOTE_PRESETS[Number(idx)];
                    if (!preset) return;
                    const text = lang === 'ar' ? preset.ar : preset.en;
                    updateTooth(selectedFdi, {
                      note: current.note.trim() ? `${current.note.trim()} — ${text}` : text,
                    });
                  }}
                  className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-300 rounded-md text-slate-700"
                >
                  <option value="">{tr(lang, '+ ملاحظة سريعة للسن...', '+ Quick tooth note...')}</option>
                  {FDI_NOTE_PRESETS.map((p, idx) => (
                    <option key={idx} value={String(idx)}>
                      {lang === 'ar' ? p.ar : p.en}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <input
              type="text"
              disabled={readOnly}
              value={current.note}
              onChange={(e) => updateTooth(selectedFdi, { note: e.target.value })}
              placeholder={tr(lang, 'مثال: ميلان حنكي، تآكل مينا، دوران 15 درجة...', 'e.g. Palatal displacement, rotation 15 deg...')}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-44 overflow-y-auto">
          <p className="text-xs font-semibold text-slate-800 mb-2">
            {tr(lang, 'الأسنان ذات الملاحظات أو الحالات الخاصة', 'Teeth with Recorded Findings')}
          </p>
          {notedTeeth.length === 0 ? (
            <p className="text-xs text-slate-500">{tr(lang, 'جميع الأسنان مسجلة كحاضرة سليمة.', 'All teeth marked present.')}</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {notedTeeth.map((t) => (
                <li key={t.fdi}>
                  <button
                    type="button"
                    onClick={() => setSelectedFdi(t.fdi)}
                    className="w-full text-start hover:bg-white px-2 py-1 rounded transition-colors flex items-baseline gap-2"
                  >
                    <span className="font-mono font-semibold text-teal-800 tabular-nums">#{t.fdi}</span>
                    <span className="text-slate-700 truncate">
                      {lang === 'ar' ? STATUS_META[t.status].ar : STATUS_META[t.status].en}
                      {t.note ? ` — ${t.note}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
