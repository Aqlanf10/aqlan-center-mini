/** Public UI identity projection only. Server writers always use requireSession. */
export function sessionActorId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
