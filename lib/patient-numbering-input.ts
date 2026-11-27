export const MANAGED_NUMBER_MAX = 999999999999999999n;
export const LEGACY_NUMBER_MAX = 9223372036854775807n;

export function canonicalPatientPrefix(value: string): string | null {
  return /^[A-Za-z]{1,6}$/.test(value) ? value.toUpperCase() : null;
}

export function patientNumberDigits(value: string): string {
  return value.trim().replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0)).replace(/^0+(?=[0-9])/, "");
}

export function patientNumberFloor(prefix: string, perPrefix: boolean): bigint {
  return perPrefix && prefix !== "P" ? 1n : 7000n;
}
