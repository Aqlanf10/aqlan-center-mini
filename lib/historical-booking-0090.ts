/** Catalog-only recognition of the historical booking contract. Unmounted:
 * never apply, adopt, repair or rewrite a registry row, and never enable Rx.
 * Caller owns one bounded transaction on its verified PostgreSQL 18 target. */
export const HISTORICAL_BOOKING_0090 = Object.freeze({
  version: "0090",
  name: "booking_request_preferences",
  sha256: "608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25",
});

export type HistoricalBooking0090 =
  | { status: "absent" }
  | { status: "verified" }
  | { status: "hold"; reason: "snapshot-required" | "catalog-unavailable" | "registry-mismatch" | "footprint-mismatch" };

interface CatalogClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Reuse the existing operator preflight's dedicated client and transaction,
 * after its target attestation, read-only/timeout settings and registry checks.
 * No SELECT of booking records; only the named migration row and pg_catalog. */
export async function inspectHistoricalBooking0090(client: CatalogClient): Promise<HistoricalBooking0090> {
  const hold = (reason: Extract<HistoricalBooking0090, {status: "hold"}>["reason"]) =>
    ({ status: "hold", reason } as const);
  try {
    const { rows: [snapshot] } = await client.query(`
      SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
             pg_catalog.current_setting('transaction_isolation') AS isolation,
             pg_catalog.current_setting('search_path') AS search_path,
             pg_catalog.current_setting('row_security') AS row_security,
             pg_catalog.current_setting('server_version_num')::int AS version`);
    if (snapshot?.read_only !== "on" || snapshot.isolation !== "repeatable read"
      || snapshot.search_path !== "pg_catalog" || snapshot.row_security !== "off"
      || typeof snapshot.version !== "number" || Math.floor(snapshot.version / 10000) !== 18) {
      return hold("snapshot-required");
    }

    const { rows: relations } = await client.query(`
      SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('schema_migrations','booking_requests')`);
    const registry = relations.find(r => r.name === "schema_migrations");
    const booking = relations.find(r => r.name === "booking_requests");
    if (registry?.kind !== "r" || registry.rls !== false || booking?.kind !== "r") return hold("catalog-unavailable");

    const { rows: headers } = await client.query(`
      SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
             a.attnotnull AS required, a.attgenerated AS generated, a.attidentity AS identity
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='public.schema_migrations'::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('version','name','checksum','adopted')`);
    if (headers.length !== 4 || headers.some(h => h.type !== (h.name === "adopted" ? "boolean" : "text")
      || h.required !== true || h.generated !== "" || h.identity !== "")) return hold("registry-mismatch");

    const { rows } = await client.query(`
      SELECT name, checksum, adopted FROM ONLY public.schema_migrations WHERE version=$1 LIMIT 2`,
      [HISTORICAL_BOOKING_0090.version]);
    const [row] = rows;
    if (rows.length > 1 || (row && (row.name !== HISTORICAL_BOOKING_0090.name
      || row.checksum !== HISTORICAL_BOOKING_0090.sha256 || row.adopted !== false))) return hold("registry-mismatch");

    const { rows: columns } = await client.query(`
      SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
             a.attnotnull AS required, a.attgenerated AS generated, a.attidentity AS identity,
             pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.booking_requests'::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('request_key','request_hash','preferences')`);

    // Read any relation with the expected name, not only indexes. A view/table
    // collision is residue, not absence. Parent identity uses a qualified OID.
    const { rows: indexes } = await client.query(`
      SELECT c.relkind AS kind, i.indrelid='public.booking_requests'::pg_catalog.regclass AS parent,
             i.indisunique AS unique_index, i.indimmediate AS immediate, i.indisvalid AS valid,
             i.indisready AS ready, i.indislive AS live, i.indnullsnotdistinct AS nulls_not_distinct,
             i.indnkeyatts::int AS keys, i.indnatts::int AS attributes, am.amname AS method,
             op.opcname AS opclass, opns.nspname AS opclass_schema,
             i.indoption[0]::int AS key_options, i.indcollation[0]=key.attcollation AS matches_collation,
             CASE WHEN i.indexrelid IS NOT NULL THEN pg_catalog.pg_get_indexdef(c.oid,1,true) END AS key,
             pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
      LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
      LEFT JOIN pg_catalog.pg_opclass op ON op.oid=i.indclass[0]
      LEFT JOIN pg_catalog.pg_namespace opns ON opns.oid=op.opcnamespace
      LEFT JOIN pg_catalog.pg_attribute key ON key.attrelid=i.indrelid AND key.attname='request_key' AND NOT key.attisdropped
      WHERE n.nspname='public' AND c.relname='booking_requests_request_key_idx'`);
    if (!row) return columns.length === 0 && indexes.length === 0 ? { status: "absent" } : hold("footprint-mismatch");

    if (columns.length !== 3 || columns.some(c => {
      const preference = c.name === "preferences";
      return c.type !== (preference ? "jsonb" : "text") || c.required !== preference
        || c.default_value !== (preference ? "'{}'::jsonb" : null) || c.generated !== "" || c.identity !== "";
    })) return hold("footprint-mismatch");
    const [index] = indexes;
    if (indexes.length !== 1 || index.kind !== "i" || index.parent !== true || index.unique_index !== true
      || index.immediate !== true || index.valid !== true || index.ready !== true || index.live !== true
      || index.nulls_not_distinct !== false || index.keys !== 1 || index.attributes !== 1
      || index.method !== "btree" || index.opclass !== "text_ops" || index.opclass_schema !== "pg_catalog"
      || index.key_options !== 0 || index.matches_collation !== true || index.key !== "request_key"
      || index.predicate !== "(request_key IS NOT NULL)") return hold("footprint-mismatch");

    return { status: "verified" };
  } catch {
    // Never include server errors, credentials, registry strings or row data.
    // Existing snapshot owner must end or roll back the transaction.
    return hold("catalog-unavailable");
  }
}
