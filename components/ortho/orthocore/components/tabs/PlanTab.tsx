"use client";
import React, { useMemo, useState } from 'react';
import { CheckCircle2, GitCommitHorizontal, Layers, Plus, Sparkles, Trash2, Wrench } from 'lucide-react';
import {
  AuxiliaryItem,
  Language,
  OrthoPhase,
  PatientCase,
  SecondaryApplianceItem,
  SlotSize,
  TreatmentGoal,
  UserRole,
} from '../../types/ortho';
import {
  APPLIANCE_CATALOG,
  APPLIANCE_CATEGORIES,
  AUXILIARY_CATALOG,
  AUXILIARY_CATEGORIES,
  ARCHWIRE_CATALOG,
  ApplianceCategoryId,
  AuxiliaryCategoryId,
  DEFAULT_WIRE_SEQUENCE,
  ORTHO_PHASES,
  WIRE_ALLOY_LABELS,
  WireAlloyGroup,
  getTodayIso,
} from '../../data/orthoCatalog';
import { tr } from '../../i18n/translations';

interface PlanTabProps {
  patient: PatientCase;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

export const PlanTab: React.FC<PlanTabProps> = ({ patient, lang, role, actorName, onChange }) => {
  const plan = patient.treatmentPlan;
  const mech = plan.mechanotherapy;
  const canApprove = role === 'doctor';

  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalProbId, setNewGoalProbId] = useState(patient.problems[0]?.id || '');
  const [newGoalProc, setNewGoalProc] = useState('');
  const [revisionReason, setRevisionReason] = useState('');

  // Expanded Appliance, Wire & Auxiliary Builder States
  const [appCatFilter, setAppCatFilter] = useState<'all' | ApplianceCategoryId>('all');
  const [secAppId, setSecAppId] = useState(APPLIANCE_CATALOG.find((a) => a.category === 'expansion_orthopedic')?.id || 'hyrax_rpe');
  const [secAppArch, setSecAppArch] = useState<'upper' | 'lower' | 'both'>('upper');
  const [secAppProtocol, setSecAppProtocol] = useState('');

  const [wireAlloyFilter, setWireAlloyFilter] = useState<'all' | WireAlloyGroup>('all');
  const [wireSlotFilter, setWireSlotFilter] = useState<'all' | '018' | '022'>('all');
  const [wireTargetArch, setWireTargetArch] = useState<'both' | 'upper' | 'lower'>('both');
  const [customWireText, setCustomWireText] = useState('');

  const [auxCatFilter, setAuxCatFilter] = useState<AuxiliaryCategoryId>('tads');
  const [selectedAuxId, setSelectedAuxId] = useState(AUXILIARY_CATALOG[0].id);
  const [auxArch, setAuxArch] = useState<'upper' | 'lower' | 'both'>('upper');
  const [auxSite, setAuxSite] = useState('');
  const [auxSpec, setAuxSpec] = useState('');

  const slotSize: SlotSize = mech.slotSize || (mech.bracketSlot.includes('0.018') || mech.bracketSlot.includes('018') ? '018' : '022');
  const upperWires = mech.wireSequenceUpper && mech.wireSequenceUpper.length > 0 ? mech.wireSequenceUpper : mech.wireSequence;
  const lowerWires = mech.wireSequenceLower && mech.wireSequenceLower.length > 0 ? mech.wireSequenceLower : mech.wireSequence;
  const secondaryAppliances = mech.secondaryAppliances || [];
  const auxiliaryItems = mech.auxiliaryItems || [];

  const selectedPrimaryAppliance = useMemo(
    () => APPLIANCE_CATALOG.find((a) => a.id === mech.primaryApplianceId) || null,
    [mech.primaryApplianceId],
  );

  const filteredCatalogWires = useMemo(() => {
    return ARCHWIRE_CATALOG.filter((w) => {
      if (wireAlloyFilter !== 'all' && w.alloyGroup !== wireAlloyFilter) return false;
      if (wireSlotFilter !== 'all' && !w.slots.includes(wireSlotFilter)) return false;
      return true;
    });
  }, [wireAlloyFilter, wireSlotFilter]);

  const filteredAuxCatalog = useMemo(
    () => AUXILIARY_CATALOG.filter((x) => x.category === auxCatFilter),
    [auxCatFilter],
  );

  const updateMech = (patch: Partial<typeof mech>, timelineMsg?: { ar: string; en: string }) => {
    onChange(
      {
        ...patient,
        treatmentPlan: {
          ...plan,
          mechanotherapy: {
            ...mech,
            ...patch,
          },
        },
      },
      timelineMsg,
    );
  };

  const addGoal = () => {
    if (!newGoalTitle.trim()) return;
    const g: TreatmentGoal = {
      id: `goal-${Date.now()}`,
      problemId: newGoalProbId || patient.problems[0]?.id || '',
      title: newGoalTitle.trim(),
      targetMetric: '',
      plannedProcedure: newGoalProc.trim(),
      executionStage: tr(lang, 'المرحلة 1', 'Phase 1'),
      outcomeStatus: 'planned',
    };
    onChange(
      { ...patient, treatmentPlan: { ...plan, goals: [...plan.goals, g] } },
      { ar: `إضافة هدف علاجي: ${g.title}`, en: `Added treatment goal: ${g.title}` },
    );
    setNewGoalTitle('');
    setNewGoalProc('');
  };

  const approveNewPlanVersion = () => {
    if (!canApprove) return;
    const nextVer = (plan.versions[0]?.version || plan.versions.length) + 1;
    const reason = revisionReason.trim() || tr(lang, 'اعتماد خطة العلاج والميكانيكا', 'Approved treatment plan & mechanotherapy');
    onChange(
      {
        ...patient,
        treatmentPlan: {
          ...plan,
          approvedBy: actorName,
          approvedAt: new Date().toISOString(),
          versions: [
            {
              version: nextVer,
              date: getTodayIso(),
              author: actorName,
              reason,
              discussedWithPatient: true,
              approvedBy: actorName,
            },
            ...plan.versions,
          ],
        },
      },
      { ar: `اعتماد نسخة خطة العلاج v${nextVer}: ${reason}`, en: `Approved treatment plan v${nextVer}: ${reason}` },
    );
    setRevisionReason('');
  };

  const handleAddWireToSequence = (code: string) => {
    const clean = code.trim();
    if (!clean) return;
    const nextU = wireTargetArch === 'both' || wireTargetArch === 'upper' ? [...upperWires, clean] : upperWires;
    const nextL = wireTargetArch === 'both' || wireTargetArch === 'lower' ? [...lowerWires, clean] : lowerWires;
    updateMech(
      {
        wireSequenceUpper: nextU,
        wireSequenceLower: nextL,
        wireSequence: Array.from(new Set([...nextU, ...nextL])),
      },
      { ar: `إضافة السلك ${clean} إلى خطة الأسلاك`, en: `Added archwire ${clean} to sequence` },
    );
  };

  const handleRemoveWire = (arch: 'upper' | 'lower', idx: number) => {
    const nextU = arch === 'upper' ? upperWires.filter((_, i) => i !== idx) : upperWires;
    const nextL = arch === 'lower' ? lowerWires.filter((_, i) => i !== idx) : lowerWires;
    updateMech({
      wireSequenceUpper: nextU,
      wireSequenceLower: nextL,
      wireSequence: Array.from(new Set([...nextU, ...nextL])),
    });
  };

  const handleLoadStandardSequence = (s: '018' | '022') => {
    const seq = DEFAULT_WIRE_SEQUENCE[s];
    updateMech(
      {
        slotSize: s,
        wireSequenceUpper: [...seq],
        wireSequenceLower: [...seq],
        wireSequence: [...seq],
      },
      { ar: `تحميل تسلسل الأسلاك القياسي لشق 0.${s}`, en: `Loaded standard 0.${s} wire sequence` },
    );
  };

  const handleAddSecondaryAppliance = () => {
    const catItem = APPLIANCE_CATALOG.find((a) => a.id === secAppId);
    if (!catItem) return;
    const item: SecondaryApplianceItem = {
      id: `sec-${Date.now()}`,
      catalogId: catItem.id,
      nameAr: catItem.ar,
      nameEn: catItem.en,
      category: catItem.category,
      arch: secAppArch,
      activationProtocol: secAppProtocol.trim() || (lang === 'ar' ? catItem.protocolAr : catItem.protocolEn),
      placedDate: getTodayIso(),
      status: 'active',
    };
    updateMech(
      { secondaryAppliances: [...secondaryAppliances, item] },
      { ar: `إضافة جهاز: ${catItem.ar}`, en: `Added appliance: ${catItem.en}` },
    );
    setSecAppProtocol('');
  };

  const handleAddAuxiliary = () => {
    const catItem = AUXILIARY_CATALOG.find((x) => x.id === selectedAuxId);
    if (!catItem) return;
    const item: AuxiliaryItem = {
      id: `aux-${Date.now()}`,
      catalogId: catItem.id,
      nameAr: catItem.ar,
      nameEn: catItem.en,
      category: catItem.category,
      arch: auxArch,
      site: auxSite.trim() || (lang === 'ar' ? catItem.siteHintAr : catItem.siteHintEn),
      spec: auxSpec.trim() || catItem.defaultSpec,
      placedDate: getTodayIso(),
      status: 'active',
    };
    const nextAuxText = Array.from(new Set([...mech.auxiliaries, `${catItem.ar} (${item.site})`]));
    updateMech(
      {
        auxiliaryItems: [...auxiliaryItems, item],
        auxiliaries: nextAuxText,
      },
      { ar: `إضافة جهاز مساعد: ${catItem.ar}`, en: `Added auxiliary: ${catItem.en}` },
    );
    setAuxSite('');
    setAuxSpec('');
  };

  return (
    <div className="space-y-6">
      {/* Plan Approval Bar */}
      <div className="bg-white border border-navy-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-navy-700 font-mono tabular-nums">
          {plan.approvedBy ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-800 font-sans font-semibold">
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {tr(lang, 'الخطة معتمدة من:', 'Approved by:')} {plan.approvedBy} ({plan.approvedAt?.slice(0, 10)})
              </span>
            </span>
          ) : (
            <span>{tr(lang, 'خطة قيد المراجعة — بانتظار اعتماد الطبيب', 'Draft Plan — Pending Clinician Approval')}</span>
          )}
        </div>
        {canApprove && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={revisionReason}
              onChange={(e) => setRevisionReason(e.target.value)}
              placeholder={tr(lang, 'سبب التعديل / التوثيق...', 'Revision / approval note...')}
              className="px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
            />
            <button
              type="button"
              onClick={approveNewPlanVersion}
              className="px-3.5 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg"
            >
              {tr(lang, 'اعتماد وحفظ نسخة الخطة', 'Approve & Version Plan')}
            </button>
          </div>
        )}
      </div>

      {/* Linked Traceability Matrix */}
      <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-bold text-navy-900">
          {tr(
            lang,
            'مصفوفة الربط العلاجي (المشكلة ← الهدف ← الإجراء المخطط ← مرحلة التنفيذ ← النتيجة)',
            'Traceability Matrix (Problem → Goal → Planned Procedure → Stage → Outcome)',
          )}
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-navy-200 text-navy-500">
                <th className="py-2 text-start">{tr(lang, 'المشكلة المرتبطة', 'Linked Problem')}</th>
                <th className="py-2 text-start">{tr(lang, 'الهدف العلاجي', 'Treatment Goal')}</th>
                <th className="py-2 text-start">{tr(lang, 'الإجراء المخطط', 'Planned Procedure')}</th>
                <th className="py-2 text-start">{tr(lang, 'مرحلة التنفيذ', 'Execution Stage')}</th>
                <th className="py-2 text-start">{tr(lang, 'النتيجة والمتابعة', 'Outcome Status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {plan.goals.map((g) => {
                const prob = patient.problems.find((p) => p.id === g.problemId);
                return (
                  <tr key={g.id}>
                    <td className="py-2.5 pe-3 text-navy-700 max-w-[200px]">{prob?.title || '—'}</td>
                    <td className="py-2.5 pe-3 font-semibold text-navy-900">{g.title}</td>
                    <td className="py-2.5 pe-3 text-navy-700">
                      <input
                        type="text"
                        value={g.plannedProcedure}
                        onChange={(e) => {
                          const nextGoals = plan.goals.map((x) => (x.id === g.id ? { ...x, plannedProcedure: e.target.value } : x));
                          onChange({ ...patient, treatmentPlan: { ...plan, goals: nextGoals } });
                        }}
                        className="w-full px-2 py-1 border border-navy-200 rounded text-xs"
                      />
                    </td>
                    <td className="py-2.5 pe-3">
                      <input
                        type="text"
                        value={g.executionStage}
                        onChange={(e) => {
                          const nextGoals = plan.goals.map((x) => (x.id === g.id ? { ...x, executionStage: e.target.value } : x));
                          onChange({ ...patient, treatmentPlan: { ...plan, goals: nextGoals } });
                        }}
                        className="w-32 px-2 py-1 border border-navy-200 rounded text-xs"
                      />
                    </td>
                    <td className="py-2.5">
                      <select
                        value={g.outcomeStatus}
                        onChange={(e) => {
                          const nextGoals = plan.goals.map((x) =>
                            x.id === g.id ? { ...x, outcomeStatus: e.target.value as TreatmentGoal['outcomeStatus'] } : x,
                          );
                          onChange({ ...patient, treatmentPlan: { ...plan, goals: nextGoals } });
                        }}
                        className="px-2 py-1 border border-navy-200 rounded text-xs bg-white"
                      >
                        <option value="planned">{tr(lang, 'مخطط', 'Planned')}</option>
                        <option value="in_progress">{tr(lang, 'قيد التنفيذ', 'In Progress')}</option>
                        <option value="achieved">{tr(lang, 'متحقق', 'Achieved')}</option>
                        <option value="modified">{tr(lang, 'معدّل', 'Modified')}</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-3 border-t border-navy-100">
          <select
            value={newGoalProbId}
            onChange={(e) => setNewGoalProbId(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-navy-200 rounded-lg bg-white"
          >
            {patient.problems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={newGoalTitle}
            onChange={(e) => setNewGoalTitle(e.target.value)}
            placeholder={tr(lang, 'الهدف العلاجي الجديد...', 'New treatment goal...')}
            className="px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
          />
          <input
            type="text"
            value={newGoalProc}
            onChange={(e) => setNewGoalProc(e.target.value)}
            placeholder={tr(lang, 'الإجراء المخطط...', 'Planned procedure...')}
            className="px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
          />
          <button
            type="button"
            onClick={addGoal}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-navy-900 text-white text-xs font-semibold rounded-lg"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{tr(lang, 'ربط هدف جديد', 'Add Linked Goal')}</span>
          </button>
        </div>
      </div>

      {/* Alternative Plans & Timeline Revisions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-navy-900">
            {tr(lang, 'الخطط البديلة ومبررات الاختيار', 'Treatment Alternatives & Rationale')}
          </h3>
          <div className="space-y-3">
            {plan.alternatives.map((alt) => (
              <div
                key={alt.id}
                className={`p-3.5 rounded-lg border space-y-2 ${
                  alt.isSelected ? 'border-brand-orange bg-accent-50/50' : 'border-navy-200 bg-white'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-navy-900">{alt.title}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const nextAlts = plan.alternatives.map((a) => ({ ...a, isSelected: a.id === alt.id }));
                      onChange({ ...patient, treatmentPlan: { ...plan, alternatives: nextAlts } });
                    }}
                    className={`px-2.5 py-1 text-[11px] rounded-md border font-semibold ${
                      alt.isSelected ? 'bg-navy-900 border-navy-900 text-white' : 'bg-white border-navy-200 text-navy-700'
                    }`}
                  >
                    {alt.isSelected ? tr(lang, 'مختارة', 'Selected') : tr(lang, 'اعتماد كخيار', 'Select')}
                  </button>
                </div>
                <p className="text-xs text-navy-600">{alt.summary}</p>
                <p className="text-[11px] text-navy-700">
                  <strong>{tr(lang, 'المبرر:', 'Rationale:')}</strong> {alt.rationale}
                </p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-navy-100">
            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">
                {tr(lang, 'المدة التقديرية (بالأشهر)', 'Estimated Duration (Months)')}
              </label>
              <input
                type="number"
                value={plan.estimatedDurationMonths ?? ''}
                onChange={(e) =>
                  onChange({
                    ...patient,
                    treatmentPlan: { ...plan, estimatedDurationMonths: Number(e.target.value) || null },
                  })
                }
                className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-navy-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">
                {tr(lang, 'متطلبات تعاون المريض', 'Patient Cooperation Requirements')}
              </label>
              <input
                type="text"
                value={plan.cooperationRequirements}
                onChange={(e) =>
                  onChange({ ...patient, treatmentPlan: { ...plan, cooperationRequirements: e.target.value } })
                }
                className="w-full px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
              />
            </div>
          </div>
        </div>

        {/* Elastics, Anchorage & Revision History */}
        <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-navy-900">
            {tr(lang, 'بروتوكول المطاطات والارتكاز وسجل النسخ', 'Elastics, Anchorage & Version History')}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">{tr(lang, 'بروتوكول المطاطات', 'Elastics Protocol')}</label>
              <input
                type="text"
                value={mech.elasticsProtocol}
                onChange={(e) => updateMech({ elasticsProtocol: e.target.value })}
                className="w-full px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">{tr(lang, 'خطة الارتكاز (Anchorage Plan)', 'Anchorage Plan')}</label>
              <input
                type="text"
                value={mech.anchoragePlan}
                onChange={(e) => updateMech({ anchoragePlan: e.target.value })}
                className="w-full px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">{tr(lang, 'ملاحظات الميكانيكا الحيوية', 'Biomechanics Notes')}</label>
              <textarea
                rows={2}
                value={mech.notes}
                onChange={(e) => updateMech({ notes: e.target.value })}
                className="w-full px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-navy-100">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-navy-700 mb-2">
              <GitCommitHorizontal className="w-3.5 h-3.5" />
              <span>{tr(lang, 'سجل نسخ خطة العلاج', 'Plan Revision History')}</span>
            </div>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {plan.versions.map((v) => (
                <div key={v.version} className="text-[11px] text-navy-600 flex justify-between border-b border-navy-100 pb-1">
                  <span>
                    <strong className="font-mono">v{v.version}</strong> — {v.reason}
                  </span>
                  <span className="font-mono tabular-nums text-navy-500">{v.date}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════════
          EXPANDED CLINICAL UNIT: 1) APPLIANCES  2) ARCHWIRES  3) AUXILIARIES
          ═══════════════════════════════════════════════════════════════════════════ */}

      {/* Panel 1: Primary & Secondary Appliances Catalog */}
      <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-navy-100">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-navy-900 text-white flex items-center justify-center">
              <Wrench className="w-4 h-4 text-brand-orange" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-navy-900">
                {tr(lang, 'الأجهزة التقويمية والنظام العلاجي الموسّع', 'Expanded Orthodontic Appliances & Prescription')}
              </h3>
              <p className="text-[11px] text-navy-500">
                {tr(lang, 'الحاصرات الثابتة، المصففات، أجهزة التوسيع العظمية، الوظيفية، وحافظات المسافة', 'Labial/Lingual brackets, Aligners, Expanders (RPE/MARPE), Functional & Habit Appliances')}
              </p>
            </div>
          </div>

          {/* Phase Pills */}
          <div className="flex flex-wrap items-center gap-1">
            {ORTHO_PHASES.map((ph) => {
              const active = (mech.orthoPhase || 'aligning') === ph.id;
              return (
                <button
                  key={ph.id}
                  type="button"
                  onClick={() => updateMech({ orthoPhase: ph.id as OrthoPhase })}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                    active ? 'bg-brand-orange text-white' : 'bg-navy-50 text-navy-700 hover:bg-navy-100'
                  }`}
                >
                  {lang === 'ar' ? ph.ar : ph.en}
                </button>
              );
            })}
          </div>
        </div>

        {/* Category Filter + Primary Appliance Grid */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAppCatFilter('all')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium ${
                appCatFilter === 'all' ? 'bg-navy-900 text-white' : 'bg-navy-50 text-navy-700 hover:bg-navy-100'
              }`}
            >
              {tr(lang, 'كل الفئات', 'All Categories')}
            </button>
            {(Object.keys(APPLIANCE_CATEGORIES) as ApplianceCategoryId[]).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setAppCatFilter(cat)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium ${
                  appCatFilter === cat ? 'bg-navy-900 text-white' : 'bg-navy-50 text-navy-700 hover:bg-navy-100'
                }`}
              >
                {lang === 'ar' ? APPLIANCE_CATEGORIES[cat].ar : APPLIANCE_CATEGORIES[cat].en}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-navy-600 mb-1">
                {tr(lang, 'الجهاز الرئيسي للحالة', 'Primary Appliance System')}
              </label>
              <select
                value={mech.primaryApplianceId || ''}
                onChange={(e) => {
                  const chosen = APPLIANCE_CATALOG.find((x) => x.id === e.target.value);
                  if (!chosen) return;
                  const legacyType =
                    chosen.category === 'lingual_aligners' && !chosen.usesArchwires
                      ? 'clear_aligners'
                      : chosen.id.includes('self_ligating')
                      ? 'fixed_self_ligating'
                      : chosen.usesArchwires
                      ? 'fixed_mbt'
                      : 'removable_functional';
                  updateMech(
                    {
                      primaryApplianceId: chosen.id,
                      applianceType: legacyType,
                      slotSize: chosen.defaultSlot,
                      bracketPrescription: chosen.prescriptions[0] || '',
                      bracketSlot: `${chosen.prescriptions[0] || chosen.ar}`,
                    },
                    { ar: `تحديد الجهاز الرئيسي: ${chosen.ar}`, en: `Set primary appliance: ${chosen.en}` },
                  );
                }}
                className="w-full px-3 py-2 text-xs border border-navy-200 rounded-lg bg-white text-navy-900 font-medium"
              >
                <option value="">{tr(lang, 'اختر من الكتالوج الموسّع...', 'Select from catalog...')}</option>
                {APPLIANCE_CATALOG.filter((a) => appCatFilter === 'all' || a.category === appCatFilter).map((a) => (
                  <option key={a.id} value={a.id}>
                    {lang === 'ar' ? a.ar : a.en}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">{tr(lang, 'حجم الشق (Slot)', 'Bracket Slot')}</label>
              <select
                value={slotSize}
                onChange={(e) => updateMech({ slotSize: e.target.value as SlotSize })}
                className="w-full px-3 py-2 text-xs font-mono border border-navy-200 rounded-lg bg-white"
              >
                <option value="022">0.022&quot; × 0.028&quot;</option>
                <option value="018">0.018&quot; × 0.025&quot;</option>
                <option value="other">{tr(lang, 'بدون شق / مصفف / متحرك', 'Slotless / Aligner / Ortho')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">{tr(lang, 'الفكّان المستهدفان', 'Target Arches')}</label>
              <select
                value={mech.arches || 'both'}
                onChange={(e) => updateMech({ arches: e.target.value as 'both' | 'upper' | 'lower' })}
                className="w-full px-3 py-2 text-xs border border-navy-200 rounded-lg bg-white"
              >
                <option value="both">{tr(lang, 'الفكّان (علوي + سفلي)', 'Both Arches')}</option>
                <option value="upper">{tr(lang, 'الفك العلوي فقط', 'Upper Arch Only')}</option>
                <option value="lower">{tr(lang, 'الفك السفلي فقط', 'Lower Arch Only')}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-navy-600 mb-1">
                {tr(lang, 'وصفة الحاصرات / نظام الجهاز', 'Prescription & System Details')}
              </label>
              <input
                type="text"
                value={mech.bracketSlot}
                onChange={(e) => updateMech({ bracketSlot: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-navy-200 rounded-lg"
              />
              {selectedPrimaryAppliance && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {selectedPrimaryAppliance.prescriptions.map((pr) => (
                    <button
                      key={pr}
                      type="button"
                      onClick={() => updateMech({ bracketPrescription: pr, bracketSlot: pr })}
                      className="px-2 py-0.5 text-[11px] font-mono rounded bg-navy-50 hover:bg-navy-100 text-navy-700 border border-navy-200"
                    >
                      {pr}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedPrimaryAppliance && (
              <div className="p-3 rounded-lg bg-navy-50 border border-navy-100 text-xs text-navy-700 flex items-center">
                <span>
                  <strong className="text-navy-900">{tr(lang, 'البروتوكول القياسي:', 'Clinical Protocol:')}</strong>{' '}
                  {lang === 'ar' ? selectedPrimaryAppliance.protocolAr : selectedPrimaryAppliance.protocolEn}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Secondary / Orthopedic / Functional Appliances Sub-manager */}
        <div className="pt-4 border-t border-navy-100 space-y-3">
          <h4 className="text-xs font-bold text-navy-900">
            {tr(lang, 'أجهزة التوسيع، الوظيفية، وحافظات المسافة المرافقة للحالة', 'Secondary, Orthopedic, Functional & Space Appliances')}
          </h4>

          {secondaryAppliances.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {secondaryAppliances.map((item) => (
                <div key={item.id} className="p-3 rounded-lg border border-navy-200 bg-navy-50/40 flex items-start justify-between gap-2 text-xs">
                  <div className="space-y-1">
                    <div className="font-bold text-navy-900">{lang === 'ar' ? item.nameAr : item.nameEn}</div>
                    <div className="text-[11px] text-navy-600">{item.activationProtocol}</div>
                    <div className="flex items-center gap-2 text-[10px] font-mono text-navy-500">
                      <span>{item.arch.toUpperCase()}</span>
                      <span>·</span>
                      <span>{item.placedDate}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <select
                      value={item.status}
                      onChange={(e) => {
                        const next = secondaryAppliances.map((x) =>
                          x.id === item.id ? { ...x, status: e.target.value as SecondaryApplianceItem['status'] } : x,
                        );
                        updateMech({ secondaryAppliances: next });
                      }}
                      className="px-2 py-1 text-[11px] border border-navy-200 rounded bg-white"
                    >
                      <option value="planned">{tr(lang, 'مخطط', 'Planned')}</option>
                      <option value="active">{tr(lang, 'فعّال', 'Active')}</option>
                      <option value="completed">{tr(lang, 'مكتمل', 'Done')}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => updateMech({ secondaryAppliances: secondaryAppliances.filter((x) => x.id !== item.id) })}
                      className="p-1 text-navy-400 hover:text-red-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <select
              value={secAppId}
              onChange={(e) => setSecAppId(e.target.value)}
              className="md:col-span-4 px-2.5 py-1.5 text-xs border border-navy-200 rounded-lg bg-white"
            >
              {APPLIANCE_CATALOG.filter((a) => a.category !== 'fixed_labial').map((a) => (
                <option key={a.id} value={a.id}>
                  {lang === 'ar' ? a.ar : a.en}
                </option>
              ))}
            </select>
            <select
              value={secAppArch}
              onChange={(e) => setSecAppArch(e.target.value as 'upper' | 'lower' | 'both')}
              className="md:col-span-2 px-2.5 py-1.5 text-xs border border-navy-200 rounded-lg bg-white"
            >
              <option value="upper">{tr(lang, 'علوي', 'Upper')}</option>
              <option value="lower">{tr(lang, 'سفلي', 'Lower')}</option>
              <option value="both">{tr(lang, 'الفكّان', 'Both')}</option>
            </select>
            <input
              type="text"
              value={secAppProtocol}
              onChange={(e) => setSecAppProtocol(e.target.value)}
              placeholder={tr(lang, 'بروتوكول التفعيل (اختياري)...', 'Activation protocol (optional)...')}
              className="md:col-span-4 px-3 py-1.5 text-xs border border-navy-200 rounded-lg"
            />
            <button
              type="button"
              onClick={handleAddSecondaryAppliance}
              className="md:col-span-2 px-3 py-1.5 rounded-lg bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{tr(lang, 'إضافة جهاز', 'Add Appliance')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Panel 2: Expanded Archwire Sequence Builder (Upper & Lower) */}
      <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-navy-100">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-brand-blue text-white flex items-center justify-center">
              <Layers className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-navy-900">
                {tr(lang, 'تسلسل الأسلاك الموسّع للفكّين (Upper & Lower Wire Sequence)', 'Expanded Dual-Arch Archwire Sequence')}
              </h3>
              <p className="text-[11px] text-navy-500">
                {tr(lang, 'NiTi، CuNiTi الحراري، RCS قوس سبي، الفولاذ المستدير والمستطيل وبخطافات، TMA، Braided، والتجميلي', 'NiTi, Thermal CuNiTi, RCS NiTi, SS Round/Rect/Posted, TMA, Twistflex, Coated & Utility')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleLoadStandardSequence('022')}
              className="px-2.5 py-1.5 rounded-lg bg-navy-50 hover:bg-navy-100 text-navy-800 border border-navy-200 text-[11px] font-semibold"
            >
              {tr(lang, 'تسلسل 0.022 القياسي', 'Load 0.022" Seq')}
            </button>
            <button
              type="button"
              onClick={() => handleLoadStandardSequence('018')}
              className="px-2.5 py-1.5 rounded-lg bg-navy-50 hover:bg-navy-100 text-navy-800 border border-navy-200 text-[11px] font-semibold"
            >
              {tr(lang, 'تسلسل 0.018 القياسي', 'Load 0.018" Seq')}
            </button>
          </div>
        </div>

        {/* Active Sequence Display for Upper & Lower */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-3.5 rounded-xl bg-navy-50/70 border border-navy-200 space-y-2">
            <div className="text-xs font-bold text-navy-900">{tr(lang, 'تسلسل الفك العلوي (Upper Arch)', 'Upper Arch Sequence')}</div>
            <div className="flex flex-wrap gap-1.5">
              {upperWires.length === 0 ? (
                <span className="text-[11px] text-navy-400">{tr(lang, 'لا توجد أسلاك مضافة بعد', 'No upper wires yet')}</span>
              ) : (
                upperWires.map((w, idx) => (
                  <button
                    key={`u-${w}-${idx}`}
                    type="button"
                    onClick={() => handleRemoveWire('upper', idx)}
                    className="px-2.5 py-1 text-xs font-mono bg-white hover:bg-red-50 hover:text-red-700 rounded-md border border-navy-200 flex items-center gap-1"
                  >
                    <span className="text-navy-400 text-[10px]">{idx + 1}.</span>
                    <span>{w}</span>
                    <span className="text-navy-400">×</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-navy-50/70 border border-navy-200 space-y-2">
            <div className="text-xs font-bold text-navy-900">{tr(lang, 'تسلسل الفك السفلي (Lower Arch)', 'Lower Arch Sequence')}</div>
            <div className="flex flex-wrap gap-1.5">
              {lowerWires.length === 0 ? (
                <span className="text-[11px] text-navy-400">{tr(lang, 'لا توجد أسلاك مضافة بعد', 'No lower wires yet')}</span>
              ) : (
                lowerWires.map((w, idx) => (
                  <button
                    key={`l-${w}-${idx}`}
                    type="button"
                    onClick={() => handleRemoveWire('lower', idx)}
                    className="px-2.5 py-1 text-xs font-mono bg-white hover:bg-red-50 hover:text-red-700 rounded-md border border-navy-200 flex items-center gap-1"
                  >
                    <span className="text-navy-400 text-[10px]">{idx + 1}.</span>
                    <span>{w}</span>
                    <span className="text-navy-400">×</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Wire Catalog Filter + Click-to-Add Chips */}
        <div className="space-y-3 pt-2 border-t border-navy-100">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={wireTargetArch}
              onChange={(e) => setWireTargetArch(e.target.value as 'both' | 'upper' | 'lower')}
              className="px-2.5 py-1.5 text-xs font-semibold border border-navy-200 rounded-lg bg-navy-900 text-white"
            >
              <option value="both">{tr(lang, 'إضافة للفكّين معاً', 'Add to Both')}</option>
              <option value="upper">{tr(lang, 'إضافة للعلوي فقط', 'Add to Upper')}</option>
              <option value="lower">{tr(lang, 'إضافة للسفلي فقط', 'Add to Lower')}</option>
            </select>

            <select
              value={wireAlloyFilter}
              onChange={(e) => setWireAlloyFilter(e.target.value as 'all' | WireAlloyGroup)}
              className="px-2.5 py-1.5 text-xs border border-navy-200 rounded-lg bg-white"
            >
              <option value="all">{tr(lang, 'جميع سبائك الأسلاك (10 فئات)', 'All Wire Alloys (10 Groups)')}</option>
              {(Object.keys(WIRE_ALLOY_LABELS) as WireAlloyGroup[]).map((g) => (
                <option key={g} value={g}>
                  {lang === 'ar' ? WIRE_ALLOY_LABELS[g].ar : WIRE_ALLOY_LABELS[g].en}
                </option>
              ))}
            </select>

            <select
              value={wireSlotFilter}
              onChange={(e) => setWireSlotFilter(e.target.value as 'all' | '018' | '022')}
              className="px-2.5 py-1.5 text-xs font-mono border border-navy-200 rounded-lg bg-white"
            >
              <option value="all">{tr(lang, 'كل المقاسات (018 & 022)', 'All Slots')}</option>
              <option value="022">Slot 0.022&quot;</option>
              <option value="018">Slot 0.018&quot;</option>
            </select>

            <div className="flex flex-1 min-w-[200px] gap-1.5">
              <input
                type="text"
                value={customWireText}
                onChange={(e) => setCustomWireText(e.target.value)}
                placeholder={tr(lang, 'سلك مخصص (مثال: 0.018×0.025 GUMMETAL)...', 'Custom wire...')}
                className="flex-1 px-3 py-1.5 text-xs font-mono border border-navy-200 rounded-lg"
              />
              <button
                type="button"
                onClick={() => {
                  handleAddWireToSequence(customWireText);
                  setCustomWireText('');
                }}
                className="px-3 py-1.5 rounded-lg bg-navy-900 text-white text-xs font-semibold"
              >
                {tr(lang, 'إضافة', 'Add')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto p-1">
            {filteredCatalogWires.map((w) => (
              <button
                key={w.code}
                type="button"
                onClick={() => handleAddWireToSequence(w.code)}
                className="text-start p-2.5 rounded-lg border border-navy-200 hover:border-brand-orange hover:bg-accent-50/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-xs font-bold text-navy-900">{w.code}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-navy-100 text-navy-700">{w.phase}</span>
                </div>
                <p className="text-[11px] text-navy-600 mt-0.5 line-clamp-1">
                  {lang === 'ar' ? w.indicationAr : w.indicationEn}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Panel 3: Expanded Auxiliary Appliances & Skeletal Anchorage (TADs, Coils, Turbos...) */}
      <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-navy-100">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-brand-orange text-white flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-navy-900">
                {tr(lang, 'الأجهزة المساعدة، الزراعات التقويمية (TADs) والمُلحقات الميكانيكية', 'Auxiliaries, TADs, Anchorage, Springs & Bite Modifiers')}
              </h3>
              <p className="text-[11px] text-navy-500">
                {tr(lang, 'تحديد المواقع التشريحية بدقة ومتابعة حالة التفعيل (مخطط / فعّال / مكتمل)', 'Track exact anatomical site, dimension/force spec & clinical status')}
              </p>
            </div>
          </div>
        </div>

        {/* Active Auxiliary Items */}
        {auxiliaryItems.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {auxiliaryItems.map((item) => (
              <div key={item.id} className="p-3 rounded-xl border border-navy-200 bg-navy-50/40 flex items-start justify-between gap-2 text-xs">
                <div className="space-y-1">
                  <div className="font-bold text-navy-900">{lang === 'ar' ? item.nameAr : item.nameEn}</div>
                  <div className="text-[11px] text-navy-700">
                    <strong>{tr(lang, 'الموقع:', 'Site:')}</strong> {item.site}
                  </div>
                  <div className="text-[11px] font-mono text-navy-600">{item.spec} · {item.arch.toUpperCase()}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <select
                    value={item.status}
                    onChange={(e) => {
                      const next = auxiliaryItems.map((x) =>
                        x.id === item.id ? { ...x, status: e.target.value as AuxiliaryItem['status'] } : x,
                      );
                      updateMech({ auxiliaryItems: next });
                    }}
                    className="px-2 py-1 text-[11px] border border-navy-200 rounded bg-white"
                  >
                    <option value="planned">{tr(lang, 'مخطط', 'Planned')}</option>
                    <option value="active">{tr(lang, 'فعّال', 'Active')}</option>
                    <option value="completed">{tr(lang, 'مكتمل', 'Done')}</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => updateMech({ auxiliaryItems: auxiliaryItems.filter((x) => x.id !== item.id) })}
                    className="p-1 text-navy-400 hover:text-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Category Filter Tabs + Builder */}
        <div className="space-y-3 pt-2 border-t border-navy-100">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(AUXILIARY_CATEGORIES) as AuxiliaryCategoryId[]).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setAuxCatFilter(cat);
                  const first = AUXILIARY_CATALOG.find((x) => x.category === cat);
                  if (first) setSelectedAuxId(first.id);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  auxCatFilter === cat ? 'bg-navy-900 text-white' : 'bg-navy-50 text-navy-700 hover:bg-navy-100'
                }`}
              >
                {lang === 'ar' ? AUXILIARY_CATEGORIES[cat].ar : AUXILIARY_CATEGORIES[cat].en}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <select
              value={selectedAuxId}
              onChange={(e) => setSelectedAuxId(e.target.value)}
              className="md:col-span-4 px-2.5 py-2 text-xs border border-navy-200 rounded-lg bg-white"
            >
              {filteredAuxCatalog.map((x) => (
                <option key={x.id} value={x.id}>
                  {lang === 'ar' ? x.ar : x.en}
                </option>
              ))}
            </select>
            <select
              value={auxArch}
              onChange={(e) => setAuxArch(e.target.value as 'upper' | 'lower' | 'both')}
              className="md:col-span-2 px-2.5 py-2 text-xs border border-navy-200 rounded-lg bg-white"
            >
              <option value="upper">{tr(lang, 'علوي', 'Upper')}</option>
              <option value="lower">{tr(lang, 'سفلي', 'Lower')}</option>
              <option value="both">{tr(lang, 'الفكّان', 'Both')}</option>
            </select>
            <input
              type="text"
              value={auxSite}
              onChange={(e) => setAuxSite(e.target.value)}
              placeholder={tr(lang, 'الموقع (مثال: 16/26 IZC أو 11-13)...', 'Site (e.g., 16/26 IZC)...')}
              className="md:col-span-3 px-3 py-2 text-xs border border-navy-200 rounded-lg"
            />
            <input
              type="text"
              value={auxSpec}
              onChange={(e) => setAuxSpec(e.target.value)}
              placeholder={tr(lang, 'المقاس / القوة (اختياري)...', 'Spec / Force...')}
              className="md:col-span-2 px-3 py-2 text-xs border border-navy-200 rounded-lg"
            />
            <button
              type="button"
              onClick={handleAddAuxiliary}
              className="md:col-span-1 px-3 py-2 rounded-lg bg-brand-orange hover:bg-accent-600 text-white text-xs font-semibold"
            >
              +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
