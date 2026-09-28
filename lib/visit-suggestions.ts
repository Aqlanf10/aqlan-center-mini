/**
 * (VISIT-1) التعبئة التلقائية للزيارة — المنطق الخالص.
 *
 * كان الطبيب يفتح الزيارة فيجد الحقول كلها فارغة، مع أن النظام يعرف أكثرها: لماذا حُجز
 * الموعد، وأيّ جلسةٍ من الخطة هذه، ومن طبيبها، وما الجلسة التالية. هنا تُبنى **اقتراحات**
 * تملأ الحقول الفارغة فقط في الشاشة — لا تُكتب في السجل حتى يحفظ الطبيب أو يوقّع، وهو يعدّلها.
 */

import { getAppointmentTypeLabel } from "./schedule";

export interface VisitSuggestionInput {
  appointmentNote: string | null;
  appointmentType: string | null;
  plannedTitle: string | null;
  inOrtho: boolean;
  nextPlanned: { title: string; afterDays: number | null } | null;
  /** بترتيب الأولوية: الطبيب الداخل (إن كان طبيبًا)، طبيب الجلسة المخطَّطة، طبيب الموعد، طبيب المريض الأساسي. */
  doctorCandidates: (number | null)[];
}

export interface VisitSuggestions {
  doctorId: number | null;
  chiefComplaint: string | null;
  nextPlan: string | null;
}

/** «يوم» / «يومين» / «٧ أيام» / «١٤ يومًا» — العدد العربي بتمييزه الصحيح. */
export function arabicDays(days: number): string {
  if (days === 1) return "يوم";
  if (days === 2) return "يومين";
  if (days >= 3 && days <= 10) return `${days} أيام`;
  return `${days} يومًا`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function buildVisitSuggestions(input: VisitSuggestionInput): VisitSuggestions {
  const note = input.appointmentNote?.trim() || null;
  const type = input.appointmentType ? getAppointmentTypeLabel(input.appointmentType) : null;
  let chiefComplaint: string | null = null;
  if (input.plannedTitle) chiefComplaint = `جلسة مخطَّطة: ${input.plannedTitle}`;
  else if (type && note) chiefComplaint = `${type} — ${note}`;
  else if (note) chiefComplaint = note;
  else if (type) chiefComplaint = type;
  else if (input.inOrtho) chiefComplaint = "متابعة تقويم — شدّ دوري";

  const next = input.nextPlanned;
  const nextPlan = next
    ? `الجلسة القادمة: ${next.title}${next.afterDays ? ` — بعد ${arabicDays(next.afterDays)}` : ""}`
    : null;

  return {
    doctorId: input.doctorCandidates.find((id): id is number => Number.isInteger(id) && (id as number) > 0) ?? null,
    chiefComplaint: chiefComplaint ? clip(chiefComplaint, 300) : null,
    nextPlan: nextPlan ? clip(nextPlan, 300) : null,
  };
}

/**
 * «ما نُفّذ» من الإجراءات المضافة: «حشوة كمبوزيت — سن 16؛ تنظيف وتلميع».
 * يُكرَّر الإجراء نفسه على السن نفسه مرةً واحدة بعدده (×2).
 */
export function treatmentDoneFromProcedures(lines: { name: string; toothCode: string | number | null; quantity: number }[]): string {
  const parts: { label: string; count: number }[] = [];
  for (const line of lines) {
    const name = line.name.trim();
    if (!name) continue;
    const tooth = String(line.toothCode ?? "").trim();
    const label = tooth ? `${name} — سن ${tooth}` : name;
    const existing = parts.find((part) => part.label === label);
    const count = Math.max(1, Math.round(line.quantity) || 1);
    if (existing) existing.count += count;
    else parts.push({ label, count });
  }
  return parts.map((part) => (part.count > 1 ? `${part.label} ×${part.count}` : part.label)).join("؛ ");
}

/** قائمة العبارات السريعة من الإعداد: مفصولة بفواصل، بلا تكرار، ٢٠ عبارةً بحدّ أقصى. */
export function parsePhraseList(setting: string | null | undefined): string[] {
  const result: string[] = [];
  for (const part of (setting ?? "").split(/[,،]/)) {
    const phrase = part.trim().slice(0, 60);
    if (phrase && !result.includes(phrase)) result.push(phrase);
    if (result.length >= 20) break;
  }
  return result;
}

/** نقرة العبارة تضيفها لما كُتب (بفاصلة عربية) — ولا تكرّرها إن كانت مكتوبةً سلفًا. */
export function appendPhrase(current: string, phrase: string): string {
  const text = current.trim();
  if (!text) return phrase;
  if (text.split(/[،,؛\n]/).map((part) => part.trim()).includes(phrase)) return current;
  return `${text}، ${phrase}`;
}

/**
 * (VISIT-1) أين يُوثَّق المريض الجالس: مريضٌ بملف ⇒ «زيارة اليوم» في ملفه (سياقه، والتوثيق،
 * ثم التحصيل وحجز الجلسة القادمة بعد التوقيع)؛ زيارة مشيٍ بلا ملف ⇒ شاشة الزيارة (منها يُربط).
 */
export function visitWorkspaceHref(visit: { id: number; patientId?: number | null }): string {
  return visit.patientId ? `/patients/${visit.patientId}?tab=today` : `/visits/${visit.id}`;
}
