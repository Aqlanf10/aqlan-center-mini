export const HR_TABS = ['tasks', 'staff', 'identity', 'contracts', 'attendance', 'leaves', 'payroll', 'reports', 'settings'] as const;
export type HrTab = typeof HR_TABS[number];
export const PROFILE_TABS = ['overview', 'contract', 'attendance', 'leaves'] as const;
export type HrProfileTab = typeof PROFILE_TABS[number];
export function hrId(value: string | null): string {
  return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : '';
}
/** Build only local HR URLs from an allowlist; never copy an external destination. */
export function hrHref(query: string, patch: Record<string, string | null>): string {
  const source = new URLSearchParams(query), params = new URLSearchParams();
  for (const key of ['tab', 'staffId', 'profileTab', 'contractId']) {
    const value = key in patch ? patch[key] : source.get(key);
    if (value && ((key === 'tab' && HR_TABS.includes(value as HrTab))
      || (key === 'profileTab' && PROFILE_TABS.includes(value as HrProfileTab))
      || ((key === 'staffId' || key === 'contractId') && hrId(value)))) params.set(key, value);
  }
  return `/hr${params.size ? `?${params}` : ''}`;
}
