/**
 * (HR-INT) مصدر شروط الأجر المعتمد للمسير — دالة نقية + قارئ من القاعدة.
 *
 * القاعدة: **العقد المعتمد/الفعّال الساري هو مصدر الأجر وتاريخ سريانه**. ملف الموظف (hr_staff) يحمل أجرًا ابتدائيًّا
 * يُستعمل مصدرًا وحيدًا فقط قبل وجود عقد سابق موثق؛ انتهاء تغطية عقد لا يثبت الرجوع لهذا الأجر.
 * وحين يغطيها عقدٌ يُزامَن الملف إليه عند التفعيل ولا يُعدَّل
 * بما يخالفه. فلا يبقى مصدران متناقضان، وإن وُجد تعارضٌ قديم يُعلن ويُمنع الاعتماد — لا يُختار أحد الرقمين تخمينًا.
 *
 * ما لم يحدّده المالك لا يُحسب ولا يُقسَّم: دوريةٌ غير شهرية، أجرٌ يتغير أثناء الفترة، التحاقٌ/انتهاء خدمةٍ منتصف الفترة،
 * أجرٌ في الملف يسري بعد بداية الفترة بلا عقدٍ يثبت السابق. كلٌّ منها «حاجب» يظهر على بند المسير ويمنع اعتماده.
 */

import type { DbClient } from "./db";
import type { Currency } from "./money";

export type PayKind = "commission" | "salary" | "salary_commission" | "unspecified";
export type SalaryPeriodUnit = "monthly" | "weekly" | "daily" | "per_shift";

export type PayBlocker =
  | "commission_policy_conflict"
  | "contract_priority_unresolved"
  | "contract_coverage_unresolved"
  | "contract_lifecycle_unresolved"
  | "terms_conflict"
  | "terms_changed_in_period"
  | "unsupported_salary_period"
  | "partial_period_employment"
  | "profile_terms_effective_after_period_start"
  | "no_pay_terms";

export const PAY_BLOCKER_LABEL: Record<PayBlocker, string> = {
  contract_priority_unresolved: "تغطي الفترة عقود مستقلة أو سلسلة ملاحق غير مكتملة؛ يلزم تحديد العقد المعتمد الحاكم قبل الاحتساب",
  contract_coverage_unresolved: "انتهت تغطية عقد سابق ولا يوجد عقد يغطي الفترة؛ مصدر الأجر بعدها يحتاج إلى قرار موثق",
  commission_policy_conflict: "نسبة العقد تختلف عن سياسة محرك العمولات السارية؛ صحّح العقد أو اعتمد السياسة عبر مسار العمولات",
  contract_lifecycle_unresolved: "حالة العقد المرجعي لا تثبت استمرار أثره على الأجر؛ راجع تاريخ الأثر والشروط المعتمدة قبل الاحتساب",
  terms_conflict: "تعارض بين أجر ملف الموظف والعقد الساري",
  terms_changed_in_period: "تغيّرت شروط الأجر أثناء الفترة (تقسيمها قرار للمالك لم يُحدَّد)",
  unsupported_salary_period: "دورية الأجر غير شهرية (احتسابها قرار للمالك لم يُحدَّد)",
  partial_period_employment: "التحاقٌ أو انتهاء خدمةٍ أثناء الفترة (التناسب قرار للمالك لم يُحدَّد)",
  profile_terms_effective_after_period_start: "أجر الملف يسري بعد بداية الفترة ولا عقد يثبت ما قبله",
  no_pay_terms: "لا شروط أجر مكتملة",
};

export interface PayTerms {
  kind: PayKind;
  salaryMinor: number | null;
  currency: Currency | null;
  salaryPeriod: SalaryPeriodUnit | null;
}

export interface ProfileInput extends PayTerms {
  effectiveOn: string | null;
  hireDate: string | null;
  endDate: string | null;
}

export interface ContractInput extends PayTerms {
  id: number;
  parentContractId?: number | null;
  contractNumber: string;
  versionNumber: number;
  status: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  startDate: string;
  endDate: string | null;
  commissionRatePercent: number | null;
  doctorPartyId: number | null;
}

export interface PayTermsResolution {
  inScope: boolean;
  terms: PayTerms | null;
  source: "contract" | "staff_profile" | null;
  contract: ContractInput | null;
  blockers: PayBlocker[];
  snapshot: Record<string, unknown>;
}

const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export const hasSalary = (kind: PayKind | null | undefined): boolean => kind === "salary" || kind === "salary_commission";
export const hasCommission = (kind: PayKind | null | undefined): boolean => kind === "commission" || kind === "salary_commission";

/** مفتاح مقارنة الشروط: نوع التعاقد، وللراتب المبلغ والعملة والدورية (النسبة لا تدخل — مصدرها المحرك القائم). */
export function payTermsKey(terms: PayTerms): string {
  return hasSalary(terms.kind)
    ? `${terms.kind}|${terms.salaryMinor}|${terms.currency}|${terms.salaryPeriod}`
    : `${terms.kind}||`;
}

const isLive = (status: string) => status === "approved" || status === "active";
// A terminal status is not a dated wage decision. Retain the approved agreement
// as an unresolved payroll witness instead of silently substituting today's
// profile. Expired legacy rows also require review; never-approved drafts do not.
const hasPayrollWitness = (contract: ContractInput) => isLive(contract.status) || contract.status === "expired"
  || Boolean(contract.approvedBy || contract.approvedAt);
const byVersion = (a: ContractInput, b: ContractInput) => b.versionNumber - a.versionNumber || b.id - a.id;
const contractEarningKey = (contract: ContractInput) => hasCommission(contract.kind)
  ? `${payTermsKey(contract)}|${contract.commissionRatePercent}|${contract.doctorPartyId}`
  : payTermsKey(contract);
const covers = (contract: ContractInput, day: string) =>
  contract.startDate <= day && (contract.endDate === null || contract.endDate >= day);
const overlaps = (contract: ContractInput, start: string, end: string) =>
  contract.startDate <= end && (contract.endDate === null || contract.endDate >= start);

/** Version numbers order addenda within one root only. Missing/cyclic ancestry
 * cannot supply a priority rule between independent approved agreements. */
function contractRoot(contract: ContractInput, all: readonly ContractInput[]): number | null {
  const visited = new Set<number>();
  let current = contract;
  while (current.parentContractId != null) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const parent = all.find(candidate => candidate.id === current.parentContractId);
    if (!parent) return null;
    current = parent;
  }
  return visited.has(current.id) ? null : current.id;
}

/** العقد الحاكم يوم معيّن: الأحدث إصدارًا بين الفعّالة/المعتمدة التي تغطي اليوم. */
export function governingContractOn(contracts: readonly ContractInput[], day: string): ContractInput | null {
  const live = contracts.filter((contract) => isLive(contract.status) && covers(contract, day));
  live.sort(byVersion);
  return live[0] ?? null;
}

const termsOf = (source: PayTerms): PayTerms => ({
  kind: source.kind, salaryMinor: source.salaryMinor, currency: source.currency, salaryPeriod: source.salaryPeriod,
});

export function resolvePayTerms(
  profile: ProfileInput,
  contracts: readonly ContractInput[],
  period: { start: string; end: string },
): PayTermsResolution {
  const { start, end } = period;
  if (profile.kind === 'unspecified') return { inScope:false,terms:null,source:null,contract:null,
    blockers:['no_pay_terms'],snapshot:{periodStart:start,periodEnd:end,identityOnly:true} };
  const blockers: PayBlocker[] = [];
  const base = { periodStart: start, periodEnd: end };
  const profileView = {
    kind: profile.kind, salaryMinor: profile.salaryMinor, currency: profile.currency,
    salaryPeriod: profile.salaryPeriod, effectiveOn: profile.effectiveOn,
  };

  if ((profile.hireDate && profile.hireDate > end) || (profile.endDate && profile.endDate < start)) {
    return { inScope: false, terms: null, source: null, contract: null, blockers, snapshot: { ...base, profile: profileView } };
  }
  if ((profile.hireDate && profile.hireDate > start) || (profile.endDate && profile.endDate < end)) {
    blockers.push("partial_period_employment");
  }

  const candidates = contracts.filter((contract) => hasPayrollWitness(contract) && overlaps(contract, start, end));
  let terms: PayTerms | null = null;
  let source: "contract" | "staff_profile" | null = null;
  let contract: ContractInput | null = null;

  if (candidates.length > 0) {
    const breakpoints = new Set<string>([start]);
    for (const candidate of candidates) {
      if (candidate.startDate > start && candidate.startDate <= end) breakpoints.add(candidate.startDate);
      if (candidate.endDate !== null) {
        const next = addDays(candidate.endDate, 1);
        if (next > start && next <= end) breakpoints.add(next);
      }
    }
    const segments = [...breakpoints].sort().map((day) => {
      const covering = candidates.filter((candidate) => covers(candidate, day));
      const roots = new Set(covering.map(candidate => contractRoot(candidate, contracts)));
      if (roots.has(null) || roots.size > 1) blockers.push("contract_priority_unresolved");
      return covering.sort(byVersion)[0] ?? null;
    });
    const keys = new Set(segments.map((segment) => (segment ? contractEarningKey(segment) : "none")));
    if (keys.size > 1) blockers.push("terms_changed_in_period");
    if (segments.some((segment) => segment && !isLive(segment.status))) blockers.push("contract_lifecycle_unresolved");
    contract = segments[0] ?? segments.find((segment) => segment !== null) ?? null;
    if (contract) {
      terms = termsOf(contract);
      source = "contract";
      if (hasSalary(terms.kind) && (terms.salaryMinor === null || terms.currency === null || terms.salaryPeriod === null)) {
        blockers.push("no_pay_terms");
      }
      // An explicitly dated approved agreement supersedes an older profile.
      // Same/later-effective or undated contradictions still require review.
      if ((!profile.effectiveOn || (profile.effectiveOn >= contract.startDate && profile.effectiveOn <= end))
        && payTermsKey(termsOf(profile)) !== payTermsKey(terms)) blockers.push("terms_conflict");
    }
  } else {
    if (contracts.some(candidate => hasPayrollWitness(candidate) && candidate.startDate <= end)) {
      // The current profile is an observation, not evidence of the wage after a
      // previous agreement ended. Keep the draft visible but never accrue it.
      blockers.push("contract_coverage_unresolved");
    }
    terms = termsOf(profile);
    source = "staff_profile";
    if (hasSalary(terms.kind)) {
      if (terms.salaryMinor === null || terms.currency === null || terms.salaryPeriod === null || profile.effectiveOn === null) {
        blockers.push("no_pay_terms");
      } else if (profile.effectiveOn > start) {
        blockers.push("profile_terms_effective_after_period_start");
      }
    }
  }

  if (terms && hasSalary(terms.kind) && terms.salaryPeriod !== null && terms.salaryPeriod !== "monthly") {
    blockers.push("unsupported_salary_period");
  }

  return {
    inScope: true,
    terms,
    source,
    contract,
    blockers: [...new Set(blockers)],
    snapshot: {
      ...base,
      source,
      contractId: contract?.id ?? null,
      contractNumber: contract?.contractNumber ?? null,
      contractStatus: contract?.status ?? null,
      versionNumber: contract?.versionNumber ?? null,
      reviewContractIds: contracts.filter(candidate => hasPayrollWitness(candidate) && candidate.startDate <= end).map(candidate => candidate.id).sort((a, b) => a - b),
      kind: terms?.kind ?? null,
      baseSalaryMinor: terms && hasSalary(terms.kind) ? terms.salaryMinor : null,
      currency: terms && hasSalary(terms.kind) ? terms.currency : null,
      salaryPeriod: terms && hasSalary(terms.kind) ? terms.salaryPeriod : null,
      contractCommissionPercent: contract?.commissionRatePercent ?? null,
      profile: profileView,
    },
  };
}

/* ── القارئ من القاعدة ─────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

const toNumberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const toTextOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export const CONTRACT_SELECT = `
  SELECT id, parent_contract_id, contract_number, version_number, status, start_date::text AS start_date, end_date::text AS end_date,
         compensation_kind, base_salary_minor, salary_currency, salary_period, commission_rate_percent, doctor_party_id,
         approved_by, approved_at::text AS approved_at
    FROM hr_contracts`;

export function contractFromRow(row: Row): ContractInput {
  return {
    id: Number(row.id),
    parentContractId: toNumberOrNull(row.parent_contract_id),
    contractNumber: String(row.contract_number),
    versionNumber: Number(row.version_number),
    status: String(row.status),
    approvedBy: toTextOrNull(row.approved_by),
    approvedAt: toTextOrNull(row.approved_at),
    startDate: String(row.start_date),
    endDate: toTextOrNull(row.end_date),
    kind: row.compensation_kind as PayKind,
    salaryMinor: toNumberOrNull(row.base_salary_minor),
    currency: toTextOrNull(row.salary_currency) as Currency | null,
    salaryPeriod: toTextOrNull(row.salary_period) as SalaryPeriodUnit | null,
    commissionRatePercent: toNumberOrNull(row.commission_rate_percent),
    doctorPartyId: toNumberOrNull(row.doctor_party_id),
  };
}

export function profileFromRow(row: Row): ProfileInput {
  return {
    kind: row.contract_kind as PayKind,
    salaryMinor: toNumberOrNull(row.salary_amount_minor),
    currency: toTextOrNull(row.salary_currency) as Currency | null,
    salaryPeriod: toTextOrNull(row.salary_period) as SalaryPeriodUnit | null,
    effectiveOn: toTextOrNull(row.salary_effective_on),
    hireDate: toTextOrNull(row.hire_date),
    endDate: toTextOrNull(row.end_date),
  };
}

export async function loadStaffContracts(client: DbClient, staffId: number): Promise<ContractInput[]> {
  const { rows } = await client.query(`${CONTRACT_SELECT} WHERE staff_id = $1`, [staffId]);
  return rows.map(contractFromRow);
}

/** العقد الحاكم الآن (يوم المركز) — يُستعمل لحراسة تعديل الملف ومزامنته. */
export async function governingContractToday(
  client: DbClient,
  staffId: number,
  clinicTimeZone: string,
): Promise<ContractInput | null> {
  const { rows: today } = await client.query<{ d: string }>(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [clinicTimeZone]);
  return governingContractOn(await loadStaffContracts(client, staffId), today[0].d);
}
