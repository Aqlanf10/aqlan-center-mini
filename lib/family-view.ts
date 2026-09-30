import type { SessionPayload } from "./auth";
import { familyMemberBalances, getPatientFamilyRecord, type PatientFamilyRecord } from "./db";
import { canAccessPatient, canViewPatientMoney } from "./patient-access";
import { canViewMoney } from "./roles";
import { familyRoleLabel, familyTotals, type CurrencyBalance, type FamilyRole } from "./patient-families";

/**
 * (PAT-4) ما يراه صاحب الجلسة من عائلة — الفحص كله في الخادم:
 *
 * - **الأفراد**: كلٌّ بوصوله المعتاد إلى ملفه. المدير والاستقبال (ومعهم الكاشير والمحاسب لكشف
 *   العائلة المالي) يرون الجميع؛ والطبيب يرى من يفتح ملفه فقط (عزل الطبيب).
 * - **المال**: القاعدة نفسها لمال المريض الواحد (`canViewPatientMoney`) لكل فرد — ومن لا يراها
 *   لا يصله رقمٌ واحد. المجموع لكل عملةٍ على حدة، على الأفراد الظاهرين له وحدهم.
 * - **الضامن**: مريضٌ لا يفتح الطبيب ملفه يظهر «ضامن» بلا اسم؛ وجوال الضامن لمن يرى المال فقط.
 */
export interface FamilyViewMember {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  role: FamilyRole | null;
  roleLabel: string;
  /** غائبٌ لمن لا يرى المال — لا صفر. */
  balances?: CurrencyBalance[];
}

export interface FamilyView {
  id: number;
  name: string;
  note: string | null;
  guarantor: {
    kind: "none" | "patient" | "external";
    patientId: number | null;
    patientNumber: string | null;
    name: string | null;
    phone: string | null;
    /** ضامنٌ مريضٌ خارج ما يفتحه صاحب الجلسة — يُعرف أن هناك ضامنًا ولا يُسمّى. */
    hidden: boolean;
  };
  members: FamilyViewMember[];
  canSeeMoney: boolean;
  /** مجموع الأفراد الظاهرين لكل عملة — لمن يرى المال فقط. */
  totals?: CurrencyBalance[];
  canEdit: boolean;
}

export function canEditFamilies(role: string | null | undefined): boolean {
  return role === "admin" || role === "reception";
}

const SEES_ALL_MEMBERS = new Set(["admin", "reception", "cashier", "accountant"]);

export type FamilyViewResult =
  | { ok: true; view: FamilyView }
  | { ok: false; reason: "not_found" | "forbidden" };

export async function buildFamilyView(session: SessionPayload, familyId: number): Promise<FamilyViewResult> {
  const record = await getPatientFamilyRecord(familyId);
  if (!record) return { ok: false, reason: "not_found" };
  return familyViewOf(session, record);
}

export async function familyViewOf(session: SessionPayload, record: PatientFamilyRecord): Promise<FamilyViewResult> {
  const seesAll = SEES_ALL_MEMBERS.has(session.role);
  if (!seesAll && session.role !== "doctor") return { ok: false, reason: "forbidden" };

  const access = await Promise.all(record.members.map(async (member) => {
    const visible = seesAll || await canAccessPatient(session, member.id).catch(() => false);
    const money = visible && await canViewPatientMoney(session, member.id).catch(() => false);
    return { member, visible, money };
  }));
  const shown = access.filter((entry) => entry.visible);
  /* الطبيب الذي لا يفتح ملف أيّ فرد لا يرى العائلة أصلًا — ولا يُقال له كم فيها. */
  if (!seesAll && shown.length === 0) return { ok: false, reason: "forbidden" };

  /* غير الطبيب: قاعدة الدور وحدها (لا تتعلق بمريضٍ بعينه)؛ والطبيب: صلاحيته على كل من يظهر له. */
  const canSeeMoney = session.role === "doctor" ? shown.every((entry) => entry.money) : canViewMoney(session.role);
  const moneyIds = canSeeMoney ? shown.map((entry) => entry.member.id) : [];
  const balances = moneyIds.length ? await familyMemberBalances(moneyIds) : new Map<number, CurrencyBalance[]>();

  const members: FamilyViewMember[] = shown.map(({ member }) => ({
    id: member.id, patientNumber: member.patientNumber, fullName: member.fullName, phone: member.phone,
    role: member.role, roleLabel: familyRoleLabel(member.role),
    ...(canSeeMoney ? { balances: balances.get(member.id) ?? [] } : {}),
  }));

  const guarantor = record.guarantor;
  let guarantorHidden = false;
  if (guarantor.kind === "patient" && guarantor.patientId !== null && !seesAll) {
    guarantorHidden = !(await canAccessPatient(session, guarantor.patientId).catch(() => false));
  }
  return {
    ok: true,
    view: {
      id: record.id, name: record.name, note: record.note,
      guarantor: {
        kind: guarantor.kind,
        patientId: guarantorHidden ? null : guarantor.patientId,
        patientNumber: guarantorHidden ? null : guarantor.patientNumber,
        name: guarantorHidden ? null : guarantor.name,
        phone: guarantorHidden || !canSeeMoney ? null : guarantor.phone,
        hidden: guarantorHidden,
      },
      members,
      canSeeMoney,
      ...(canSeeMoney ? { totals: familyTotals(members.map((member) => ({ balances: member.balances ?? [] }))) } : {}),
      canEdit: canEditFamilies(session.role),
    },
  };
}
