import type { Client } from "pg";

/** Resolve only pg_proc.prolang's allocation identity to a complete finite
 * language/handler graph (including builtin validators). No routine is invoked.
 * All implementation/security fields remain exact; only identified graph
 * foreign keys become schema-qualified identities. Missing edges fail closed.
 */
export async function readLanguageContract(client: Client, oid: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query(`
    WITH RECURSIVE language_ids(oid) AS (
      SELECT $1::oid
      UNION SELECT p.prolang FROM language_ids x JOIN pg_catalog.pg_language l ON l.oid=x.oid
        JOIN pg_catalog.pg_proc p ON p.oid IN (l.lanplcallfoid,l.laninline,l.lanvalidator)
    ), languages AS (
      SELECT l.* FROM pg_catalog.pg_language l JOIN language_ids x ON x.oid=l.oid
    ), routines AS (
      SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid IN (
        SELECT unnest(ARRAY[l.lanplcallfoid,l.laninline,l.lanvalidator]) FROM languages l)
    ), objects AS (
      SELECT 'pg_language'::regclass::oid classid,oid objid FROM languages
      UNION SELECT 'pg_proc'::regclass::oid,oid FROM routines
    ), dependencies AS (
      SELECT o.classid,o.objid,COALESCE(jsonb_agg(jsonb_build_object('kind',d.deptype,
        'type',(pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)).type,
        'identity',(pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)).identity)
        ORDER BY d.deptype,(pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)).type COLLATE "C",
          (pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)).identity COLLATE "C")
        FILTER(WHERE d.objid IS NOT NULL),'[]'::jsonb) AS value
      FROM objects o LEFT JOIN pg_catalog.pg_depend d ON d.classid=o.classid AND d.objid=o.objid GROUP BY o.classid,o.objid
    ), labels AS (
      SELECT o.classid,o.objid,COALESCE(jsonb_agg(jsonb_build_object('provider',s.provider,'label',s.label)
        ORDER BY s.provider) FILTER(WHERE s.objoid IS NOT NULL),'[]'::jsonb) AS value
      FROM objects o LEFT JOIN pg_catalog.pg_seclabel s ON s.classoid=o.classid AND s.objoid=o.objid GROUP BY o.classid,o.objid
    )
    SELECT jsonb_build_object('name',root.lanname,
      'languages',(SELECT jsonb_agg((to_jsonb(l)-ARRAY['oid','lanowner','lanplcallfoid','laninline','lanvalidator']) ||
        jsonb_build_object('owner',pg_get_userbyid(l.lanowner),'effective_acl',COALESCE(l.lanacl,acldefault('l',l.lanowner)),
          'handlers',(SELECT jsonb_agg(jsonb_build_object('slot',h.slot,'present',h.oid<>0,
            'identity',CASE WHEN p.oid IS NULL THEN NULL ELSE (pg_identify_object('pg_proc'::regclass,p.oid,0)).identity END)
            ORDER BY h.slot COLLATE "C") FROM (VALUES ('call',l.lanplcallfoid),('inline',l.laninline),('validator',l.lanvalidator)) h(slot,oid)
            LEFT JOIN routines p ON p.oid=h.oid),
          'dependencies',(SELECT value FROM dependencies WHERE classid='pg_language'::regclass AND objid=l.oid),
          'security_labels',(SELECT value FROM labels WHERE classid='pg_language'::regclass AND objid=l.oid))
        ORDER BY l.lanname COLLATE "C") FROM languages l),
      'routines',(SELECT COALESCE(jsonb_agg((to_jsonb(p)-ARRAY['oid','pronamespace','proowner','prolang']) || jsonb_build_object(
        'identity',(pg_identify_object('pg_proc'::regclass,p.oid,0)).identity,
        'namespace',n.nspname,'namespace_security',jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl),
        'owner',pg_get_userbyid(p.proowner),'effective_acl',COALESCE(p.proacl,acldefault('f',p.proowner)),
        'definition',pg_get_functiondef(p.oid),'language',pl.lanname,
        'dependencies',(SELECT value FROM dependencies WHERE classid='pg_proc'::regclass AND objid=p.oid),
        'security_labels',(SELECT value FROM labels WHERE classid='pg_proc'::regclass AND objid=p.oid))
        ORDER BY (pg_identify_object('pg_proc'::regclass,p.oid,0)).identity COLLATE "C"),'[]'::jsonb)
        FROM routines p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN languages pl ON pl.oid=p.prolang)) AS contract
    FROM languages root WHERE root.oid=$1::oid`, [oid]);
  if (rows.length !== 1) throw new Error("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
  const contract = rows[0].contract;
  if (!contract?.name || !Array.isArray(contract.languages) || !Array.isArray(contract.routines)
      || contract.languages.length > 16 || contract.routines.length > 64) throw new Error("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
  const names = new Set(contract.languages.map((language: { lanname: string }) => language.lanname));
  const routines = new Set(contract.routines.map((routine: { identity: string }) => routine.identity));
  if (!names.has(contract.name) || names.size !== contract.languages.length || routines.size !== contract.routines.length) throw new Error("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
  for (const language of contract.languages) {
    if (!Array.isArray(language.handlers) || language.handlers.map((handler: { slot: string }) => handler.slot).sort().join() !== "call,inline,validator") throw new Error("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
    for (const handler of language.handlers) if (handler.present ? !routines.has(handler.identity) : handler.identity !== null) throw new Error("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
  }
  for (const routine of contract.routines) if (!names.has(routine.language) || !routine.definition || !routine.namespace) throw new Error("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
  return contract;
}

/** Source shape only. Action-time equality retains every security field, which
 * must match a separately reviewed raw reference. No target normalization.
 */
export function languageSourceStructure(input: Record<string, unknown>) {
  const contract = structuredClone(input);
  const removeSecurity = (value: Record<string, unknown>) => {
    for (const key of ["owner", "lanacl", "proacl", "effective_acl"]) delete value[key];
  };
  for (const language of contract.languages as Array<Record<string, unknown>>) removeSecurity(language);
  for (const routine of contract.routines as Array<Record<string, unknown>>) {
    removeSecurity(routine);
    const namespace = routine.namespace_security as Record<string, unknown>;
    delete namespace.owner; delete namespace.acl;
  }
  return contract;
}
