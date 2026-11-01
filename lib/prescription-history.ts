import type { DbClient } from "./db";
import { sanitizeRxItems } from "./prescription";
import { encodePrescriptionPrintCursor, type PrescriptionPrintCursor } from "./prescription-print-pagination";
/** Read-only immutable clinical snapshot. Caller must establish current clinical
 * authority and patient access. Never use for the reception print-only grant. */
export async function querySavedPrescriptionHistory(client: Pick<DbClient, "query">, patientId: number, visitId: number | null, cursor: PrescriptionPrintCursor | null, timeZone: string) {
  const { rows } = await client.query<{
    id: number; visit_id: number | null; created_at: Date; cursor_created_at: string;
    prescribing_doctor_name: string | null; status: "active" | "void"; items: unknown; void_reason: string | null;
  }>(`SELECT id, visit_id, created_at, prescribing_doctor_name, status, items, void_reason,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM prescriptions WHERE patient_id=$1 AND status IN ('active', 'void') AND ($2::int IS NULL OR visit_id=$2::int)
      AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::int))
      ORDER BY created_at DESC, id DESC LIMIT 51`, [patientId, visitId, cursor?.createdAt ?? null, cursor?.id ?? null]);
  const page = rows.slice(0, 50), last = page.at(-1);
  const formatter = new Intl.DateTimeFormat("ar-YE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    prescriptions: page.map(row => ({ id: row.id, visitId: row.visit_id, createdAt: row.created_at.toISOString(), createdAtLabel: formatter.format(row.created_at), timeZone,
      prescribingDoctorName: row.prescribing_doctor_name, status: row.status, items: sanitizeRxItems(row.items), voidReason: row.void_reason })),
    nextCursor: rows.length > 50 && last ? encodePrescriptionPrintCursor({ patientId, visitId, id: last.id, createdAt: last.cursor_created_at }) : null,
  };
}
