import { parseIntakeLifecycleCommand, type IntakeLifecycleCommand } from "./ortho-assessment-lifecycle";
import type { IntakeRead } from "./ortho-assessment-intake-client";

export interface IntakeEditorDraft {
  version: 1; action: "open" | "activate" | "cancel"; reason: string; intakeKind: "new" | "transferred" | "unknown";
  bridge: string; appliance: string; arches: string; slot: string; bracketSystem: string; phase: string;
  startState: "" | "known" | "unknown"; startDate: string; startReason: string; plannedMonths: string; financialPlan: string;
}
export function blankIntakeEditor(action: IntakeEditorDraft["action"]): IntakeEditorDraft {
  return { version: 1, action, reason: "", intakeKind: "unknown", bridge: "", appliance: "", arches: "", slot: "", bracketSystem: "", phase: "",
    startState: "", startDate: "", startReason: "", plannedMonths: "", financialPlan: "" };
}
export function readIntakeEditor(serialized: string, action: IntakeEditorDraft["action"]): IntakeEditorDraft | null {
  if (!serialized) return blankIntakeEditor(action);
  if (serialized.length > 16_384) return null;
  try {
    const v = JSON.parse(serialized), keys = Object.keys(blankIntakeEditor(action));
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))
      || v.version !== 1 || !["open","activate","cancel"].includes(v.action) || !["new","transferred","unknown"].includes(v.intakeKind)
      || !["","known","unknown"].includes(v.startState)
      || keys.filter(k => k !== "version").some(k => typeof v[k] !== "string" || v[k].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v[k]))) return null;
    return v as IntakeEditorDraft;
  } catch { return null; }
}
export function intakeEditorCommand(draft: IntakeEditorDraft, read: IntakeRead, commandId: string):
  {ok:true;value:IntakeLifecycleCommand} | {ok:false;message:string} {
  const base = { schemaVersion: 1, commandId, patientId: read.patientId, reason: draft.reason.trim() };
  const fail = (message: string) => ({ok:false as const,message});
  let raw: unknown;
  if (draft.action === "open") {
    const selected = read.clinicalCases.find(v => String(v.id) === draft.bridge);
    if (draft.bridge !== "new" && !selected) return fail("اختر الحالة السريرية الموجودة أو افتح حلقة تقييم جديدة صراحةً.");
    raw = {...base,kind:"open_assessment",intakeKind:draft.intakeKind,bridge: draft.bridge === "new" ? {mode:"new"} :
      {mode:"existing",clinicalCaseId:selected!.id,expectedContentHash:selected!.contentHash}};
  } else {
    if (!read.openCase || read.openCase.status !== "assessment") return fail("الحالة المحددة ليست في مرحلة التقييم الآن.");
    const identity={orthoCaseId:read.openCase.orthoCaseId,clinicalCaseId:read.openCase.clinicalCaseId,expectedLifecycleVersion:read.openCase.lifecycleVersion};
    if (draft.action === "cancel") raw={...base,...identity,kind:"cancel_assessment"};
    else {
      const selected=read.plans.find(v=>String(v.id)===draft.financialPlan);
      if (draft.financialPlan && !selected) return fail("الاتفاق المختار غير متاح في القراءة الحالية؛ لم يُستبدل باتفاق آخر.");
      if (draft.plannedMonths && !/^[1-9]\d{0,2}$/.test(draft.plannedMonths)) return fail("المدة عدد أشهر صحيح، أو اتركها فارغة إذا كانت مجهولة.");
      if (!draft.startState) return fail("بيّن صراحةً هل تاريخ بدء العلاج معلوم أم مجهول.");
      raw={...base,...identity,kind:"activate_assessment",financialPlan:selected?{id:selected.id,expectedContentHash:selected.contentHash}:null,
        treatment:{appliance:draft.appliance,arches:draft.arches,phase:draft.phase,slot:draft.slot||null,bracketSystem:draft.bracketSystem.trim()||null,
          start:draft.startState==="known"?{state:"known",date:draft.startDate}:{state:"unknown",reason:draft.startReason.trim()},
          plannedMonths:draft.plannedMonths?Number(draft.plannedMonths):null}};
    }
  }
  const result=parseIntakeLifecycleCommand(raw);
  return result.ok?result:fail("راجع سبب التدوين والحقائق المختارة. لا تُملأ بيانات العلاج المجهولة تلقائيًا.");
}
