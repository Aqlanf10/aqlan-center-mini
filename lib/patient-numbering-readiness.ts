/** Read-only, predeployment check. No ensureSchema, migration, locks, credentials,
 * patient rows or alias values are returned. Run BEFORE deployment/migrations. */
export const PATIENT_NUMBER_KEY_EXPRESSION = `CASE WHEN upper(trim(patient_number)) ~ '^P-[0-9]+$'
  THEN 'P-' || COALESCE(NULLIF(ltrim(substring(upper(trim(patient_number)) FROM 3),'0'),''),'0')
  ELSE upper(trim(patient_number)) END`;
export async function patientNumberingReadiness(client: {
  query: (sql: string) => Promise<{rows: Record<string, unknown>[]}>
}): Promise<{ready: boolean; ambiguousAliasGroups: number}> {
  const {rows} = await client.query(`SELECT count(*)::int AS ambiguous_alias_groups FROM
    (SELECT ${PATIENT_NUMBER_KEY_EXPRESSION} AS alias_key FROM public.patients GROUP BY 1 HAVING count(*)>1) ambiguous`);
  const count = rows[0]?.ambiguous_alias_groups;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Patient numbering readiness result unavailable");
  return {ready: count === 0, ambiguousAliasGroups: count};
}
