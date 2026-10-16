import type { DbClient } from '../../lib/db';
/** Synthetic DB evidence: hash every public table and observe every sequence without nextval. */
export async function identityDatabaseState(db: Pick<DbClient, 'query'>) {
  const { rows: tables } = await db.query("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unexpected fixture table name');
    result[`table:${name}`] = (await db.query(`SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS hash FROM "${name}" t`)).rows[0];
  }
  const { rows: sequences } = await db.query("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
  for (const { name } of sequences) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unexpected fixture sequence name');
    result[`sequence:${name}`] = (await db.query(`SELECT last_value::text,is_called FROM "${name}"`)).rows[0];
  }
  return result;
}
