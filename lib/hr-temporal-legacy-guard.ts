import type { DbClient } from './db';
/** Called under the existing staff lock, so a dated write and a legacy edit cannot race. */
export async function hasDocumentedEmploymentHistory(client: DbClient, staffId: number): Promise<boolean> {
  const { rows: [schema] } = await client.query("SELECT to_regclass('public.hr_effective_streams') IS NOT NULL AND to_regclass('public.hr_effective_revisions') IS NOT NULL AS available");
  if (!schema.available) return false;
  const { rows: [row] } = await client.query(`SELECT EXISTS(SELECT 1 FROM hr_effective_streams s JOIN hr_effective_revisions r ON r.stream_id=s.id
    WHERE s.kind='employment' AND s.staff_id=$1) AS documented`, [staffId]);
  return row.documented === true;
}
