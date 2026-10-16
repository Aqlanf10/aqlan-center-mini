/** Browser-safe strict primitives. Newly authored; no clinical defaults or numeric coercion. */
export type Checked<T> = { ok: true; value: T } | { ok: false; code: string };
export const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length
  && names.every(name => Object.prototype.hasOwnProperty.call(value,name));
export const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const boundedText = (value: unknown, maximum: number): value is string => typeof value === "string"
  && value.length <= maximum && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
export const assessmentTimestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const assessmentDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10) === value;
export const assessmentFinite = (value: unknown, maxAbsolute = 1_000_000): value is number => typeof value === "number"
  && Number.isFinite(value) && Math.abs(value) <= maxAbsolute;
