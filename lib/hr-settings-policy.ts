/** Canonical HR policy fields. Legacy seed aliases are read, never written anew. */
export const MAX_ATTENDANCE_GRACE_MINS = 120; // Existing hr_work_schedules constraint.
const fields = {
  payroll_cycle: { defaultCurrency: 'default_currency', salaryDay: 'salary_day', cutoffDay: 'cutoff_day' },
  attendance_policy: { lateGraceMins: 'late_grace_mins', lateDeductionRatePerHour: 'late_deduction_rate_per_hour', overtimeRateMultiplier: 'overtime_rate_multiplier' },
  leave_policy: { annualDefaultDays: 'annual_default_days', probationMonths: 'probation_months' },
} as const;
export type HrPolicyKey = keyof typeof fields;
export function normalizeHrPolicy(key: string, raw: unknown, patch = false): Record<string, unknown> {
  if (!Object.hasOwn(fields, key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('صيغة سياسة الموارد البشرية غير صالحة.');
  const source = raw as Record<string, unknown>;
  const aliases = fields[key as HrPolicyKey];
  const allowed = new Set(Object.entries(aliases).flatMap(([name, alias]) => [name, alias]));
  if (Object.keys(source).some(name => !allowed.has(name))) throw new Error('حقل سياسة غير معروف.');
  const result: Record<string, unknown> = {};
  for (const [name, alias] of Object.entries(aliases)) {
    if (name in source && alias in source && source[name] !== source[alias]) throw new Error('قيمتا الحقل متعارضتان.');
    const value = Object.hasOwn(source, name) ? source[name] : source[alias];
    if (value === undefined && patch) continue;
    if (name === 'defaultCurrency') {
      if (!['YER', 'SAR', 'USD'].includes(value as string)) throw new Error('العملة غير معتمدة.');
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('قيمة السياسة يجب أن تكون رقمًا غير سالب.');
      if (['salaryDay','cutoffDay','lateGraceMins','probationMonths'].includes(name) && !Number.isInteger(value)) throw new Error('قيمة السياسة يجب أن تكون عددًا صحيحًا.');
      if (['salaryDay','cutoffDay'].includes(name) && (value < 1 || value > 31)) throw new Error('يوم الشهر بين1 و31.');
      if (name === 'lateGraceMins' && value > MAX_ATTENDANCE_GRACE_MINS) throw new Error('سماح الحضور لا يتجاوز120 دقيقة وفق حدود الجدول الحالي.');
    }
    result[name] = value;
  }
  return result;
}
