/**
 * (PAT-4) العائلات والضامن — القواعد الخالصة (بلا قاعدة): رموز الصلة وتسمياتها، وتحقّق المسودة،
 * ومجموع أرصدة العائلة لكل عملة.
 *
 * قرار المالك: **الضامن معلومةٌ وكشفٌ فقط** — لا يغيّر أي منطقٍ مالي، لا سند عائلي ولا توزيع دفعةٍ
 * على الأفراد؛ دفتر كل مريض كما هو. والمجموع هنا جمعٌ للعرض داخل كل عملةٍ على حدة — لا جمع بين
 * العملات أبدًا.
 */
import { toWhatsAppNumber } from "./reminders";
import { CURRENCIES, type Currency } from "./money";

export const FAMILY_ROLES = ["father", "mother", "son", "daughter", "spouse", "sibling", "other"] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

export const FAMILY_ROLE_LABEL: Record<FamilyRole, string> = {
  father: "أب",
  mother: "أم",
  son: "ابن",
  daughter: "ابنة",
  spouse: "زوج/زوجة",
  sibling: "أخ/أخت",
  other: "قريب",
};

/** أقصى طول لاسم العائلة (يطابق قيد القاعدة). */
export const FAMILY_NAME_MAX = 80;
/** أقصى عدد أفرادٍ يُربطون عند الإنشاء في طلبٍ واحد. */
export const FAMILY_CREATE_MAX_MEMBERS = 20;
const NOTE_MAX = 500;
const GUARANTOR_NAME_MAX = 120;

export function isFamilyRole(value: unknown): value is FamilyRole {
  return typeof value === "string" && (FAMILY_ROLES as readonly string[]).includes(value);
}

/** تسمية الصلة — رمزٌ مجهول (أُضيف لاحقًا أو قديم) يُعرض «قريب» لا رمزًا إنجليزيًّا. */
export function familyRoleLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return isFamilyRole(role) ? FAMILY_ROLE_LABEL[role] : FAMILY_ROLE_LABEL.other;
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string; field: string };

/** الصلة: فارغة = غير محددة؛ وإلا رمزٌ من القائمة. */
export function parseFamilyRole(raw: unknown): Result<FamilyRole | null> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (!isFamilyRole(raw)) return { ok: false, message: "صلة القرابة غير معروفة.", field: "role" };
  return { ok: true, value: raw };
}

/** اسم العائلة: مسافاتٌ موحّدة، بين حرفٍ و٨٠ حرفًا. */
export function parseFamilyName(raw: unknown): Result<string> {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, message: "اكتب اسم العائلة (مثل: عائلة الحكيمي).", field: "name" };
  if (name.length > FAMILY_NAME_MAX) return { ok: false, message: `اسم العائلة ${FAMILY_NAME_MAX} حرفًا على الأكثر.`, field: "name" };
  return { ok: true, value: name };
}

export function parseFamilyNote(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: "الملاحظة نصٌّ.", field: "note" };
  const note = raw.trim();
  if (note.length > NOTE_MAX) return { ok: false, message: `الملاحظة ${NOTE_MAX} حرف على الأكثر.`, field: "note" };
  return { ok: true, value: note || null };
}

export type GuarantorDraft =
  | { kind: "none" }
  | { kind: "patient"; patientId: number }
  | { kind: "external"; name: string; phone: string | null };

function positiveId(raw: unknown): number | null {
  const id = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/** جوال الضامن من خارج المرضى — بالصيغة نفسها التي يُخزَّن بها جوال المريض (الدولية إن أمكن). */
export function normalizeGuarantorPhone(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: "جوال الضامن غير صالح.", field: "guarantorPhone" };
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return { ok: false, message: "جوال الضامن غير صالح.", field: "guarantorPhone" };
  return { ok: true, value: toWhatsAppNumber(trimmed) ?? digits };
}

/**
 * الضامن: لا شيء، أو مريضٌ مسجّل (رقم ملفه الداخلي)، أو شخصٌ من خارج المرضى باسمه وجواله —
 * واحدٌ فقط (قيدٌ في القاعدة كذلك).
 */
export function parseGuarantor(raw: unknown): Result<GuarantorDraft> {
  if (raw === undefined || raw === null) return { ok: true, value: { kind: "none" } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "بيانات الضامن غير صالحة.", field: "guarantor" };
  const source = raw as Record<string, unknown>;
  if (source.kind === "none") return { ok: true, value: { kind: "none" } };
  if (source.kind === "patient") {
    const patientId = positiveId(source.patientId);
    if (!patientId) return { ok: false, message: "اختر المريض الضامن.", field: "guarantor" };
    return { ok: true, value: { kind: "patient", patientId } };
  }
  if (source.kind === "external") {
    const name = typeof source.name === "string" ? source.name.replace(/\s+/g, " ").trim() : "";
    if (!name) return { ok: false, message: "اكتب اسم الضامن.", field: "guarantorName" };
    if (name.length > GUARANTOR_NAME_MAX) return { ok: false, message: `اسم الضامن ${GUARANTOR_NAME_MAX} حرفًا على الأكثر.`, field: "guarantorName" };
    const phone = normalizeGuarantorPhone(source.phone);
    if (!phone.ok) return phone;
    return { ok: true, value: { kind: "external", name, phone: phone.value } };
  }
  return { ok: false, message: "نوع الضامن: مريضٌ مسجّل أو شخصٌ من خارج المرضى.", field: "guarantor" };
}

export interface FamilyMemberDraft { patientId: number; role: FamilyRole | null }

export interface FamilyDraft {
  name: string;
  note: string | null;
  guarantor: GuarantorDraft;
  members: FamilyMemberDraft[];
}

/** مسودة إنشاء عائلة: اسمٌ، وضامنٌ اختياري، وأفرادٌ أوّلون (بلا تكرار) بصلاتهم. */
export function validateFamilyDraft(raw: unknown): Result<FamilyDraft> {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const name = parseFamilyName(source.name);
  if (!name.ok) return name;
  const note = parseFamilyNote(source.note);
  if (!note.ok) return note;
  const guarantor = parseGuarantor(source.guarantor);
  if (!guarantor.ok) return guarantor;
  const rawMembers = source.members ?? [];
  if (!Array.isArray(rawMembers)) return { ok: false, message: "قائمة الأفراد غير صالحة.", field: "members" };
  if (rawMembers.length > FAMILY_CREATE_MAX_MEMBERS) {
    return { ok: false, message: `أضف ${FAMILY_CREATE_MAX_MEMBERS} فردًا على الأكثر في المرة الواحدة.`, field: "members" };
  }
  const members: FamilyMemberDraft[] = [];
  const seen = new Set<number>();
  for (const entry of rawMembers) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const patientId = positiveId(item.patientId);
    if (!patientId) return { ok: false, message: "رقم أحد الأفراد غير صالح.", field: "members" };
    if (seen.has(patientId)) return { ok: false, message: "أحد الأفراد مكرر في القائمة.", field: "members" };
    seen.add(patientId);
    const role = parseFamilyRole(item.role);
    if (!role.ok) return role;
    members.push({ patientId, role: role.value });
  }
  return { ok: true, value: { name: name.value, note: note.value, guarantor: guarantor.value, members } };
}

export interface CurrencyBalance { currency: Currency; balanceMinor: number }

/**
 * مجموع أرصدة الأفراد **لكل عملةٍ على حدة** — لا تحويل ولا جمع بين العملات. العملة التي مجموعها
 * صفر ولا رصيد فيها لأي فرد لا تظهر. (للعرض فقط؛ لا يُنشئ أو يوزّع مالًا.)
 */
export function familyTotals(members: readonly { balances: readonly CurrencyBalance[] }[]): CurrencyBalance[] {
  const sums = new Map<Currency, number>();
  const seen = new Set<Currency>();
  for (const member of members) {
    for (const line of member.balances) {
      seen.add(line.currency);
      sums.set(line.currency, (sums.get(line.currency) ?? 0) + line.balanceMinor);
    }
  }
  return CURRENCIES.filter((currency) => seen.has(currency))
    .map((currency) => ({ currency, balanceMinor: sums.get(currency) ?? 0 }));
}
