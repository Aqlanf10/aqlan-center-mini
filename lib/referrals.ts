/**
 * (P3-8) الإحالة الصادرة — أن يرسل الطبيب مريضه إلى جرّاح أو أخصائي بخطاب.
 *
 * في عيادة تقويم هذا يومي: قلعٌ قبل التقويم (١٤ و٢٤ و٣٤ و٤٤)، جراحة ناب منطمر،
 * تقييم لثة قبل تركيب الجهاز، صورة CBCT. كان الخطاب يُكتب بخط اليد ولا يُحفظ، فلا
 * يُعرف بعد شهر هل قُلعت الأسنان أم ما زال المريض ينتظر — والتقويم متوقف عليه.
 *
 * هنا: الخطاب يُطبع باسم المركز والطبيب، ويبقى في ملف المريض مفتوحًا حتى يُغلق
 * بنتيجته («قُلعت الأربعة في ١٢/١٠») أو يُلغى بسببٍ مكتوب. دوال خالصة: التحقق
 * والتسميات هنا، والقاعدة والشاشة تستهلكانها.
 */

export const REFERRAL_SPECIALTIES = [
  "oral_surgery", "periodontics", "endodontics", "prosthodontics", "implant",
  "restorative", "pediatric", "radiology", "ent", "other",
] as const;
export type ReferralSpecialty = (typeof REFERRAL_SPECIALTIES)[number];

export const REFERRAL_SPECIALTY_LABEL: Record<ReferralSpecialty, string> = {
  oral_surgery: "جراحة الفم والفكين",
  periodontics: "أمراض اللثة",
  endodontics: "علاج الجذور (العصب)",
  prosthodontics: "التركيبات",
  implant: "زراعة الأسنان",
  restorative: "الحشوات والترميم",
  pediatric: "طب أسنان الأطفال",
  radiology: "الأشعة (CBCT / بانوراما)",
  ent: "أنف وأذن وحنجرة",
  other: "أخرى",
};

export const REFERRAL_URGENCIES = ["routine", "soon", "urgent"] as const;
export type ReferralUrgency = (typeof REFERRAL_URGENCIES)[number];

export const REFERRAL_URGENCY_LABEL: Record<ReferralUrgency, string> = {
  routine: "اعتيادية",
  soon: "خلال أسبوع",
  urgent: "عاجلة",
};

export type ReferralStatus = "sent" | "completed" | "cancelled";

export const REFERRAL_STATUS_LABEL: Record<ReferralStatus, string> = {
  sent: "أُرسلت — بانتظار النتيجة",
  completed: "اكتملت",
  cancelled: "أُلغيت",
};

export interface Referral {
  id: number;
  patientId: number;
  toName: string;
  toSpecialty: ReferralSpecialty;
  reason: string;
  teeth: string | null;
  urgency: ReferralUrgency;
  status: ReferralStatus;
  outcomeNote: string | null;
  doctorPartyId: number | null;
  doctorName: string | null;
  createdBy: string;
  createdAt: string;
  closedBy: string | null;
  closedAt: string | null;
  /* (REF-1) الإحالة الداخلية — للخارجية: kind = external والباقي فارغ. */
  kind: ReferralKind;
  toPartyId: number | null;
  workflowState: WorkflowState | null;
  caseId: number | null;
  caseTitle: string | null;
  blocksCaseId: number | null;
  planItemId: number | null;
  requestedServiceId: number | null;
  returnToPartyId: number | null;
  appointmentId: number | null;
  appointmentDate: string | null;
  acceptedAt: string | null;
  completedBy: string | null;
  completedAt: string | null;
  returnedAt: string | null;
  procedurePerformed: string | null;
  followupRequired: boolean | null;
  mayReturn: boolean | null;
  /** (REF-2) آخر موعدٍ للإحالة لم يتم («لم يحضر»/«أُلغي الموعد») وهي بانتظار إعادة الحجز. */
  missedAppointment: MissedAppointment | null;
}

export interface ReferralDraft {
  toName: string;
  toSpecialty: ReferralSpecialty;
  reason: string;
  teeth: string | null;
  urgency: ReferralUrgency;
}

/** أرقام FDI للأسنان الدائمة (11–48) واللبنية (51–85). */
export function isFdiTooth(value: number): boolean {
  const quadrant = Math.floor(value / 10);
  const tooth = value % 10;
  if (quadrant >= 1 && quadrant <= 4) return tooth >= 1 && tooth <= 8;
  if (quadrant >= 5 && quadrant <= 8) return tooth >= 1 && tooth <= 5;
  return false;
}

/**
 * «14، 24 34-44» ⇒ "14, 24, 34, 44" — بترتيب الكتابة وبلا تكرار.
 * أي رمزٍ ليس رقم FDI صالحًا يرفض الحقل كله: الخطاب إلى جرّاحٍ يقلع لا يحتمل رقمًا
 * مشكوكًا فيه.
 */
export function normalizeTeeth(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const tokens = raw.split(/[\s,،;؛\-/]+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: true, value: null };
  const seen: number[] = [];
  for (const token of tokens) {
    const digits = token.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    const value = Number(digits);
    if (!/^\d{2}$/.test(digits) || !isFdiTooth(value)) {
      return { ok: false, message: `«${token}» ليس رقم سنٍّ صالحًا بترقيم FDI (مثل 14 أو 36 أو 55).` };
    }
    if (!seen.includes(value)) seen.push(value);
  }
  if (seen.length > 32) return { ok: false, message: "عدد الأسنان أكبر من المعقول." };
  return { ok: true, value: seen.join(", ") };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function checkReferralDraft(input: Record<string, unknown>):
  { ok: true; value: ReferralDraft } | { ok: false; message: string } {
  const toName = text(input.toName);
  if (toName.length < 2) return { ok: false, message: "اكتب اسم الطبيب أو المركز المحال إليه." };
  if (toName.length > 120) return { ok: false, message: "اسم المحال إليه أطول من 120 حرفًا." };

  const toSpecialty = text(input.toSpecialty) as ReferralSpecialty;
  if (!REFERRAL_SPECIALTIES.includes(toSpecialty)) return { ok: false, message: "اختر تخصص المحال إليه." };

  const reason = text(input.reason);
  if (reason.length < 3) return { ok: false, message: "اكتب سبب الإحالة والمطلوب من الزميل." };
  if (reason.length > 1000) return { ok: false, message: "سبب الإحالة أطول من 1000 حرف." };

  const teeth = normalizeTeeth(text(input.teeth));
  if (!teeth.ok) return teeth;

  const urgencyRaw = text(input.urgency) || "routine";
  if (!REFERRAL_URGENCIES.includes(urgencyRaw as ReferralUrgency)) return { ok: false, message: "درجة الاستعجال غير معروفة." };

  return { ok: true, value: { toName, toSpecialty, reason, teeth: teeth.value, urgency: urgencyRaw as ReferralUrgency } };
}

/** إغلاق الإحالة: الاكتمال بنتيجةٍ اختيارية، والإلغاء بسببٍ إلزامي. */
export function checkReferralClose(input: Record<string, unknown>):
  { ok: true; value: { status: "completed" | "cancelled"; note: string | null } } | { ok: false; message: string } {
  const action = text(input.action);
  const note = text(input.note);
  if (note.length > 1000) return { ok: false, message: "الملاحظة أطول من 1000 حرف." };
  if (action === "complete") return { ok: true, value: { status: "completed", note: note || null } };
  if (action === "cancel") {
    if (note.length < 3) return { ok: false, message: "اكتب سبب إلغاء الإحالة." };
    return { ok: true, value: { status: "cancelled", note } };
  }
  return { ok: false, message: "إجراء غير معروف." };
}

// ─── (REF-1) الإحالة الداخلية — docs/INTERNAL_REFERRAL_WORKFLOW.md ─────────────────────────

export type ReferralKind = "external" | "internal";

export const WORKFLOW_STATES = [
  "requested", "accepted", "scheduled", "arrived", "in_progress",
  "completed", "returned_to_referrer", "declined", "cancelled",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_STATE_LABEL: Record<WorkflowState, string> = {
  requested: "طُلبت — بانتظار قبول الزميل",
  accepted: "قُبلت — بانتظار الحجز",
  scheduled: "حُجز موعدها",
  arrived: "وصل المريض",
  in_progress: "قيد العلاج",
  completed: "اكتملت — عادت إلى المحيل",
  returned_to_referrer: "اطّلع عليها المحيل",
  declined: "اعتذر الزميل",
  cancelled: "أُلغيت",
};

/** الحالة القديمة التي تقابل كل حالة سير عمل — والقيد نفسه في القاعدة. */
export function legacyStatusOf(state: WorkflowState): ReferralStatus {
  if (state === "completed" || state === "returned_to_referrer") return "completed";
  if (state === "declined" || state === "cancelled") return "cancelled";
  return "sent";
}

export const REFERRAL_ACTIONS = ["accept", "decline", "schedule", "complete", "acknowledge", "cancel"] as const;
export type ReferralAction = (typeof REFERRAL_ACTIONS)[number];

/** من أي حالة يصحّ كل فعل — وما عداه 409. */
const ACTION_FROM: Record<ReferralAction, readonly WorkflowState[]> = {
  accept: ["requested"],
  decline: ["requested", "accepted"],
  schedule: ["requested", "accepted", "scheduled"],
  complete: ["accepted", "scheduled", "arrived", "in_progress"],
  acknowledge: ["completed"],
  cancel: ["requested", "accepted", "scheduled", "arrived", "in_progress"],
};

const ACTION_TO: Record<ReferralAction, WorkflowState> = {
  accept: "accepted",
  decline: "declined",
  schedule: "scheduled",
  complete: "completed",
  acknowledge: "returned_to_referrer",
  cancel: "cancelled",
};

export function nextReferralState(current: WorkflowState, action: ReferralAction): WorkflowState | null {
  return ACTION_FROM[action].includes(current) ? ACTION_TO[action] : null;
}

/**
 * من يفعل ماذا: المستقبِل يقبل ويعتذر ويُكمل؛ المحيل يلغي ويطّلع على ما عاد؛ والحجز للاستقبال
 * والمستقبِل. والمدير يستطيع كل شيء. لا أحد يكتب النتيجة السريرية باسم غيره.
 */
export function canActOnReferral(input: {
  action: ReferralAction; role: string; actorPartyId: number | null;
  referringPartyId: number | null; receivingPartyId: number | null;
}): boolean {
  if (input.role === "admin") return true;
  const isReceiver = input.actorPartyId !== null && input.actorPartyId === input.receivingPartyId;
  const isReferrer = input.actorPartyId !== null && input.actorPartyId === input.referringPartyId;
  switch (input.action) {
    case "accept": case "decline": case "complete": return input.role === "doctor" && isReceiver;
    case "schedule": return input.role === "reception" || (input.role === "doctor" && isReceiver);
    case "cancel": case "acknowledge": return input.role === "doctor" && isReferrer;
  }
}

export interface InternalReferralDraft {
  toPartyId: number;
  toSpecialty: ReferralSpecialty;
  reason: string;
  teeth: string | null;
  urgency: ReferralUrgency;
  caseId: number | null;
  blocksCaseId: number | null;
  planItemId: number | null;
  requestedServiceId: number | null;
}

const optionalId = (raw: unknown): { ok: true; value: number | null } | { ok: false } => {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? { ok: true, value: id } : { ok: false };
};

export function checkInternalReferralDraft(input: Record<string, unknown>):
  { ok: true; value: InternalReferralDraft } | { ok: false; message: string } {
  const toParty = optionalId(input.toPartyId);
  if (!toParty.ok || toParty.value === null) return { ok: false, message: "اختر الطبيب المحال إليه داخل المركز." };
  const toSpecialty = text(input.toSpecialty) as ReferralSpecialty;
  if (!REFERRAL_SPECIALTIES.includes(toSpecialty)) return { ok: false, message: "اختر تخصص المحال إليه." };
  const reason = text(input.reason);
  if (reason.length < 3) return { ok: false, message: "اكتب سبب الإحالة والمطلوب من الزميل." };
  if (reason.length > 1000) return { ok: false, message: "سبب الإحالة أطول من 1000 حرف." };
  const teeth = normalizeTeeth(text(input.teeth));
  if (!teeth.ok) return teeth;
  const urgencyRaw = text(input.urgency) || "routine";
  if (!REFERRAL_URGENCIES.includes(urgencyRaw as ReferralUrgency)) return { ok: false, message: "درجة الاستعجال غير معروفة." };
  const caseId = optionalId(input.caseId);
  const blocksCaseId = optionalId(input.blocksCaseId);
  const planItemId = optionalId(input.planItemId);
  const requestedServiceId = optionalId(input.requestedServiceId);
  if (!caseId.ok || !blocksCaseId.ok || !planItemId.ok || !requestedServiceId.ok) {
    return { ok: false, message: "رابط الحالة أو البند أو الخدمة غير صالح." };
  }
  return {
    ok: true,
    value: {
      toPartyId: toParty.value, toSpecialty, reason, teeth: teeth.value, urgency: urgencyRaw as ReferralUrgency,
      caseId: caseId.value, blocksCaseId: blocksCaseId.value, planItemId: planItemId.value,
      requestedServiceId: requestedServiceId.value,
    },
  };
}

export interface ReferralTransition {
  action: ReferralAction;
  note: string | null;
  appointmentId: number | null;
  procedurePerformed: string | null;
  followupRequired: boolean | null;
  mayReturn: boolean | null;
}

export function checkReferralTransition(input: Record<string, unknown>):
  { ok: true; value: ReferralTransition } | { ok: false; message: string } {
  const action = text(input.action) as ReferralAction;
  if (!REFERRAL_ACTIONS.includes(action)) return { ok: false, message: "فعلٌ غير معروف على الإحالة." };
  const note = text(input.note);
  if (note.length > 1000) return { ok: false, message: "الملاحظة أطول من 1000 حرف." };
  if ((action === "decline" || action === "cancel") && note.length < 3) {
    return { ok: false, message: action === "decline" ? "اكتب سبب الاعتذار عن الإحالة." : "اكتب سبب إلغاء الإحالة." };
  }
  const appointment = optionalId(input.appointmentId);
  if (!appointment.ok) return { ok: false, message: "رقم الموعد غير صالح." };
  if (action === "schedule" && appointment.value === null) return { ok: false, message: "اختر موعد الإحالة." };
  const procedurePerformed = text(input.procedurePerformed);
  if (procedurePerformed.length > 500) return { ok: false, message: "وصف ما أُنجز أطول من 500 حرف." };
  if (action === "complete" && procedurePerformed.length < 2) return { ok: false, message: "اكتب ما أُنجز للمريض ليعود إلى المحيل." };
  const flag = (raw: unknown) => raw === true ? true : raw === false ? false : null;
  return {
    ok: true,
    value: {
      action, note: note || null, appointmentId: appointment.value,
      procedurePerformed: procedurePerformed || null,
      followupRequired: flag(input.followupRequired), mayReturn: flag(input.mayReturn),
    },
  };
}

// ─── (REF-2) خطوات النظام على الإحالة: الوصول، والتقدّم بالتوقيع، وسقوط الموعد ─────────────

/**
 * ما يحدث للإحالة من الأحداث التشغيلية لا من يد أحد:
 * - `arrive`: وصل المريض على موعدها → «وصل» (من «حُجز» فقط).
 * - `progress`: وُقّعت زيارةٌ تنفّذ عملها → «قيد العلاج» (من المقبولة/المحجوزة/الواصل).
 * - `unschedule`: أُلغي موعدها أو لم يحضر → تعود لانتظار الحجز («قُبلت»، أو «طُلبت» إن حُجزت قبل القبول).
 * غير ذلك: لا شيء (والحدث التشغيلي نفسه لا يُرفض بسببها).
 */
export type ReferralSystemEvent = "arrive" | "progress" | "unschedule";

export function systemReferralStep(
  current: WorkflowState, event: ReferralSystemEvent, options: { wasAccepted: boolean } = { wasAccepted: true },
): WorkflowState | null {
  switch (event) {
    case "arrive": return current === "scheduled" ? "arrived" : null;
    case "progress": return current === "accepted" || current === "scheduled" || current === "arrived" ? "in_progress" : null;
    case "unschedule": return current === "scheduled" ? (options.wasAccepted ? "accepted" : "requested") : null;
  }
}

export type MissedAppointment = "no_show" | "cancelled";

export const MISSED_APPOINTMENT_LABEL: Record<MissedAppointment, string> = {
  no_show: "لم يحضر",
  cancelled: "أُلغي الموعد",
};

/** عنوان كل خطوةٍ في الخط الزمني للمريض — من سطر التدقيق الذي كُتب معها. */
export const REFERRAL_TIMELINE_LABEL: Record<string, string> = {
  "referral.create": "طُلبت",
  "referral.accept": "قُبلت",
  "referral.schedule": "حُجز موعدها",
  "referral.arrive": "وصل المريض",
  "referral.progress": "بدأ العلاج",
  "referral.complete": "اكتملت وعادت إلى المحيل",
  "referral.return": "اطّلع عليها المحيل",
  "referral.decline": "اعتذر الزميل",
  "referral.cancel": "أُلغيت",
  "referral.unschedule": "عادت لانتظار الحجز",
};
