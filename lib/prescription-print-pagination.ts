/** Cursor is a position, never authorization. Every page repeats server access checks. */
export type PrescriptionPrintCursor = { patientId: number; visitId: number | null; createdAt: string; id: number };
export function encodePrescriptionPrintCursor(cursor: PrescriptionPrintCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodePrescriptionPrintCursor(raw: string | null, patientId: number, visitId: number | null): PrescriptionPrintCursor | null {
  if (raw === null) return null;
  try {
    if (raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (value.patientId !== patientId || value.visitId !== visitId || !Number.isSafeInteger(value.id) || value.id <= 0
      || typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt.slice(0, 23) + "Z") throw new Error();
    return { patientId, visitId, createdAt: value.createdAt, id: value.id };
  } catch { throw new Error("PRESCRIPTION_CURSOR_INVALID"); }
}
