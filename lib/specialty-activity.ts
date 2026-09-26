/**
 * (RPT-SPEC — طلب المالك) التقرير حسب التخصص: فوق المال (التحصيل والمديونية) ما يُسأل عنه
 * كل يوم — كم إجراءً وكم زيارةً في كل تخصص، ومن الطبيب، وما كلّف المختبر والمواد، وما بقي.
 *
 * منطقٌ خالص على صفوفٍ محمَّلة سلفًا — يُختبر بلا قاعدة:
 * - **الإجراء** بند زيارةٍ منجز (visit_procedures) بتخصص خدمته، والكمية تُعدّ.
 * - **المختبر** بعملة تكلفته (لا تحويل): التخصص من إجراءات زيارته إن كان واحدًا، وإلا من
 *   نوع خدمة المختبر ونوع العمل؛ وما لا يُعرف تخصصه يبقى «بلا تخصص» ولا يُخمَّن.
 * - **المواد** تُحسب في lib/reports.ts لكل جزء تحصيل بنسبته السارية لحظتها (محرّك العمولات).
 */
import { CURRENCIES, type Currency } from "./money";

export interface SpecialtyProcedure {
  date: string;
  visitId: number;
  patientId: number | null;
  doctorId: number | null;
  category: string | null;
  quantity: number;
}

export interface SpecialtyLabCost {
  date: string;
  doctorId: number | null;
  /** فئة خدمة المختبر (prostho، ortho، implant…) أو null. */
  labCategory: string | null;
  workType: string;
  /** تخصص الزيارة المرتبطة إن كانت إجراءاتها من تخصصٍ واحد. */
  visitCategory: string | null;
  costMinor: number;
  currency: Currency;
}

/** تخصص أمر المختبر — لا يُخمَّن ما لا دليل عليه. */
export function labOrderCategory(order: Pick<SpecialtyLabCost, "labCategory" | "workType" | "visitCategory">): string | null {
  if (order.visitCategory) return order.visitCategory;
  const work = order.workType ?? "";
  if (/تقويم|حافظ مسافة|ortho/i.test(work)) return "ortho";
  if (/زرع|implant/i.test(work)) return "implant";
  if (/جسر|bridge/i.test(work)) return "bridge";
  if (/فينير|عدسة|قشر|veneer/i.test(work)) return "veneer";
  if (/تاج|crown/i.test(work)) return "crown";
  switch (order.labCategory) {
    case "ortho": return "ortho";
    case "implant": return "implant";
    case "restorative": return "filling";
    // «prostho» وحدها لا تكفي: الطقم ليس تاجًا ولا جسرًا — يبقى بلا تخصص ولا يُخمَّن.
    default: return null;
  }
}

export interface SpecialtyActivity {
  procedures: number;
  visits: number;
  patients: number;
  doctors: number;
}

/** نشاط كل تخصص في المدى: إجراءات (بالكمية) وزيارات ومرضى وأطباء — مفتاح null لما بلا تخصص. */
export function activityBySpecialty(
  procedures: readonly SpecialtyProcedure[],
  from: string,
  to: string,
  doctorId: number | null = null,
): Map<string | null, SpecialtyActivity> {
  const buckets = new Map<string | null, { procedures: number; visits: Set<number>; patients: Set<number>; doctors: Set<number> }>();
  for (const row of procedures) {
    if (row.date < from || row.date > to) continue;
    if (doctorId !== null && row.doctorId !== doctorId) continue;
    const bucket = buckets.get(row.category)
      ?? { procedures: 0, visits: new Set<number>(), patients: new Set<number>(), doctors: new Set<number>() };
    bucket.procedures += Math.max(1, row.quantity);
    bucket.visits.add(row.visitId);
    if (row.patientId !== null) bucket.patients.add(row.patientId);
    if (row.doctorId !== null) bucket.doctors.add(row.doctorId);
    buckets.set(row.category, bucket);
  }
  const result = new Map<string | null, SpecialtyActivity>();
  for (const [key, bucket] of buckets) {
    result.set(key, {
      procedures: bucket.procedures,
      visits: bucket.visits.size,
      patients: bucket.patients.size,
      doctors: bucket.doctors.size,
    });
  }
  return result;
}

/** إجراءات كل (تخصص × طبيب) في المدى. */
export function proceduresBySpecialtyDoctor(
  procedures: readonly SpecialtyProcedure[],
  from: string,
  to: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of procedures) {
    if (row.date < from || row.date > to) continue;
    const key = specialtyDoctorKey(row.category, row.doctorId);
    counts.set(key, (counts.get(key) ?? 0) + Math.max(1, row.quantity));
  }
  return counts;
}

export function specialtyDoctorKey(category: string | null, doctorId: number | null): string {
  return `${category ?? ""}\u0001${doctorId ?? ""}`;
}

export function parseSpecialtyDoctorKey(key: string): { category: string | null; doctorId: number | null } {
  const [category, doctor] = key.split("\u0001");
  return { category: category || null, doctorId: doctor ? Number(doctor) : null };
}

/** تكلفة المختبر لكل تخصص بعملتها في المدى. */
export function labCostBySpecialty(
  orders: readonly SpecialtyLabCost[],
  from: string,
  to: string,
  doctorId: number | null = null,
): Map<string | null, Record<Currency, number>> {
  const result = new Map<string | null, Record<Currency, number>>();
  for (const order of orders) {
    if (order.date < from || order.date > to) continue;
    if (doctorId !== null && order.doctorId !== doctorId) continue;
    const key = labOrderCategory(order);
    const record = result.get(key) ?? emptyRecord();
    record[order.currency] += order.costMinor;
    result.set(key, record);
  }
  return result;
}

export function emptyRecord(): Record<Currency, number> {
  return Object.fromEntries(CURRENCIES.map((currency) => [currency, 0])) as Record<Currency, number>;
}
