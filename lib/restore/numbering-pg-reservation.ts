import type { Pool } from "pg";
import { PATIENT_NUMBER_MAX } from "../patient-numbering-policy";
import type { IndependentNumberingWatermark } from "./numbering-floor-policy";
import type { IndependentReservationBackend, IndependentReservationTransaction } from "./numbering-reservation";

/**
 * Uninstalled adapter for a separately provisioned, independently durable
 * PostgreSQL authority. Never use the clinic pool or restored database here.
 * No schema creation, credentials, activation, or runtime wiring.
 *
 * Contract: generation_admission(lineage PK, generation) and
 * numbering_watermarks(lineage, prefix, reserved_through bigint,
 * PRIMARY KEY(lineage,prefix)). Generation replacement MUST lock the same
 * admission row and preserve every watermark. All writers must use this
 * authority, not just restored writers. Storage isolation and old application
 * fencing must be independently proven before activation.
 */
export function createIndependentPgReservationBackend(
  independentPool: Pick<Pool, "connect">,
  schema: string,
): IndependentReservationBackend {
  if (typeof schema !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid authority schema");
  const admission = `"${schema}".generation_admission`;
  const watermarks = `"${schema}".numbering_watermarks`;
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
  return {
    async transaction<T>(binding: Parameters<IndependentReservationBackend["transaction"]>[0],
      work: (tx: IndependentReservationTransaction) => Promise<T>): Promise<T> {
      const { lineage, generation } = binding;
      if (!identifier(lineage) || !identifier(generation)) throw new Error("Invalid authority binding");
      const client = await independentPool.connect();
      let discard = false;
      let active = false;
      let commitAttempted = false;
      let commitConfirmed = false;
      try {
        // A failed or ambiguous BEGIN must never return an uncertain session
        // to the pool. The connection is reusable only after a confirmed BEGIN
        // followed by a confirmed COMMIT or ROLLBACK.
        discard = true;
        const begun = await client.query("BEGIN");
        if (begun.command !== "BEGIN") throw new Error("Authority begin not confirmed");
        discard = false;
        active = true;
        await client.query("SET LOCAL synchronous_commit = on");
        const admitted = await client.query<{ generation: string }>(
          `SELECT generation FROM ${admission} WHERE lineage=$1 FOR UPDATE`, [lineage]);
        if (admitted.rows.length !== 1 || admitted.rows[0].generation !== generation) {
          throw new Error("Generation not admitted");
        }
        let read: IndependentNumberingWatermark | null = null;
        let advanceAttempted = false;
        let inFlight = false;
        const result = await work({
          async readFresh(prefix) {
            if (!active || inFlight || advanceAttempted || typeof prefix !== "string" || !/^[A-Z]$/.test(prefix)) throw new Error("Invalid watermark read");
            inFlight = true;
            try {
              const rows = (await client.query<{ reserved_through: string }>(
                `SELECT reserved_through::text FROM ${watermarks}
                  WHERE lineage=$1 AND prefix=$2 FOR UPDATE`, [lineage, prefix])).rows;
              if (rows.length !== 1 || typeof rows[0].reserved_through !== "string"
                || !/^(0|[1-9][0-9]{0,17})$/.test(rows[0].reserved_through)) {
                read = null;
                return null;
              }
              read = Object.freeze({ lineage, generation, prefix, reservedThrough: BigInt(rows[0].reserved_through) });
              return read;
            } finally { inFlight = false; }
          },
          async advance(previous, next) {
            if (!active || inFlight || advanceAttempted || !read || previous !== read || typeof next !== "bigint"
              || next <= read.reservedThrough || next > PATIENT_NUMBER_MAX) return false;
            // Consume the attempt before yielding to the SQL driver. A second
            // asynchronous caller cannot advance the same transaction again.
            advanceAttempted = true;
            inFlight = true;
            try {
              const update = await client.query(
                `UPDATE ${watermarks} SET reserved_through=$3::bigint
                  WHERE lineage=$1 AND prefix=$2 AND reserved_through=$4::bigint`,
                [lineage, read.prefix, next.toString(), read.reservedThrough.toString()]);
              const advanced = update.rowCount === 1;
              if (update.rowCount !== 0 && !advanced) throw new Error("Invalid watermark cardinality");
              return advanced;
            } finally { inFlight = false; }
          },
        });
        if (inFlight) throw new Error("Unawaited authority operation");
        active = false;
        commitAttempted = true;
        const committed = await client.query("COMMIT");
        if (committed.command !== "COMMIT") throw new Error("Authority commit not confirmed");
        commitConfirmed = true;
        return result;
      } catch (error) {
        active = false;
        if (commitAttempted && !commitConfirmed) discard = true;
        else {
          try {
            const rolledBack = await client.query("ROLLBACK");
            if (rolledBack.command !== "ROLLBACK") discard = true;
          } catch { discard = true; }
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
  };
}
