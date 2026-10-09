import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { captureReceiptQueries, evidenceFrames, explainCapturedQueries, safeRunProvenance, sha256 } from "./_receipt-query-evidence";
import { unavailableReceiptProvenance, type ReceiptProvenance } from "../../lib/receipt-provenance";

// Authored SOURCE ONLY. Execute later only in the existing disposable PG18 job.
// Guard BEFORE stubPostgresEnv removes deployment markers and before app import.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment, correctPayment } = await import("../../lib/db");
const { readReceiptProvenance, RECEIPT_PROVENANCE_CONTEXT_LIMIT, RECEIPT_PROVENANCE_REQUEST_LIMIT } =
  await import("../../lib/receipt-provenance-db");

const BASE = "b18f762486d8f7b1a84bb855cb454b7a48f28217";
const SOURCE_HASHES = {
  "lib/receipt-provenance-db.ts": "4dd0c716013b25df510d36570e27181e4d680a9dd4daa7da2d68809367db187b",
  "lib/receipt-provenance.ts": "3edae9e481561b4ec0198e0d2457820f66faf15d8bafc44688f71bb72b579a7b",
};
const UNRELATED_ROWS = 8_000;
const PRIVATE_REASON = "SYNTHETIC-PERF-PRIVATE-REASON", PRIVATE_ACTOR = "SYNTHETIC-PERF-PRIVATE-ACTOR";
type Receipt = { id: number; receiptNumber: string; patientId: number; shiftId: number; amountMinor: number };
type Chain = { patientId: number; receipts: [Receipt, Receipt, Receipt, Receipt, Receipt] };
let sequence = 0, shiftId: number, serverVersion: number;
let exact: Chain, overflow: Chain, multi: Chain, requestedMulti: number[];
let fixtureCounts: { scopedPatients: number; scopedPayments: number; unrelatedPayments: number; unrelatedAudits: number };

async function q<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await getPool().query<Row>(sql, params)).rows;
}
async function patient() {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'SYNTHETIC-RECEIPT-PERFORMANCE') RETURNING id`, [`PERF-P-${++sequence}`]))[0].id;
}
async function chain(): Promise<Chain> {
  const patientId = await patient();
  const paid = await recordPayment({ patientId, invoiceId: null, kind: "payment", amountMinor: 9_000,
    currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "SYNTHETIC-PERF" });
  if (paid.reason !== null || !paid.payment) throw new Error("synthetic initial receipt failed");
  async function correction(paymentId: number, amountMinor: number) {
    const answer = await correctPayment({ paymentId, reason: PRIVATE_REASON, actor: PRIVATE_ACTOR, actorRole: "admin",
      replacement: { amountMinor, currency: "YER", exchangeRate: 1, method: "cash", target: { kind: "original" } } });
    if (answer.reason !== null || !answer.reversal || !answer.replacement) throw new Error("synthetic canonical correction failed");
    return { reversal: answer.reversal, replacement: answer.replacement };
  }
  const first = await correction(paid.payment.id, 6_000), second = await correction(first.replacement.id, 3_000);
  return { patientId, receipts: [paid.payment, first.reversal, first.replacement, second.reversal, second.replacement] };
}
async function filler(patientIds: number[], countPerPatient: number, prefix: string) {
  // Bulk source-only fixtures, not a substitute for canonical correction writers.
  await q(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
    exchange_rate, base_amount_minor, base_currency, method, created_by)
    SELECT $1 || '-' || p::text || '-' || n::text, p, $2, 'payment', 100, 'YER', 1, 100, 'YER', 'cash', 'SYNTHETIC-PERF'
    FROM unnest($3::int[]) p CROSS JOIN generate_series(1, $4::int) n`, [prefix, shiftId, patientIds, countPerPatient]);
}
const SNAPSHOT_TABLES = ["patients", "payments", "invoices", "cashier_shifts", "audit_log", "journal_manual",
  "journal_manual_lines", "document_prints"] as const;
async function snapshot() {
  // Hash ALL columns and ALL rows in these tables, ordered by PK. Return no raw
  // records to evidence. Both actual reader and EXPLAIN must leave them identical.
  return (await q(`SELECT ${SNAPSHOT_TABLES.map(table => `(SELECT jsonb_build_object('rows', count(*), 'sha256',
    encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb)::text, 'UTF8')), 'hex'))
    FROM ${table} t) AS ${table}`).join(",")}`))[0];
}
const ref = ({ id, receiptNumber }: Receipt) => ({ id, receiptNumber });
function assertChain(result: Record<string, ReceiptProvenance>, fixture: Chain, middleOnly = false) {
  const [a, reverseA, b, reverseB, c] = fixture.receipts;
  const expected = {
    [a.id]: { status: "available", reversal: { state: "full", reversedMinor: 9_000, remainingMinor: 0 },
      reversalOf: null, correction: { mode: "correct", reversal: ref(reverseA), replacement: ref(b) },
      correctionReversal: null, replacementOf: null, correctionUnverified: false },
    [reverseA.id]: { status: "available", reversal: null, reversalOf: ref(a), correction: null,
      correctionReversal: { mode: "correct", original: ref(a) }, replacementOf: null, correctionUnverified: false },
    [b.id]: { status: "available", reversal: { state: "full", reversedMinor: 6_000, remainingMinor: 0 }, reversalOf: null,
      correction: { mode: "correct", reversal: ref(reverseB), replacement: ref(c) }, correctionReversal: null,
      replacementOf: ref(a), correctionUnverified: false },
    [reverseB.id]: { status: "available", reversal: null, reversalOf: ref(b), correction: null,
      correctionReversal: { mode: "correct", original: ref(b) }, replacementOf: null, correctionUnverified: false },
    [c.id]: { status: "available", reversal: { state: "none", reversedMinor: 0, remainingMinor: 3_000 }, reversalOf: null,
      correction: null, correctionReversal: null, replacementOf: ref(b), correctionUnverified: false },
  };
  for (const id of middleOnly ? [b.id] : fixture.receipts.map(receipt => receipt.id)) expect(result[id]).toEqual(expected[id]);
}

beforeAll(async () => {
  // Source fingerprints bind evidence to the immutable accepted production reader.
  for (const [path, digest] of Object.entries(SOURCE_HASHES)) expect(sha256(readFileSync(path))).toBe(digest);
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  serverVersion = Number((await q<{ version: string }>("SELECT current_setting('server_version_num') AS version"))[0].version);
  expect(Math.floor(serverVersion / 10_000)).toBe(18);
  expect(RECEIPT_PROVENANCE_CONTEXT_LIMIT).toBe(5_000);
  expect(RECEIPT_PROVENANCE_REQUEST_LIMIT).toBe(1_000);
  const shift = await openShift({ openedBy: "SYNTHETIC-PERF", opening: { YER: 0, SAR: 0, USD: 0 } });
  if (!shift) throw new Error("synthetic shift failed");
  shiftId = shift.id;
  const unrelatedPatient = await patient();
  await filler([unrelatedPatient], UNRELATED_ROWS, "PERF-UNRELATED");
  await q(`INSERT INTO audit_log (action, entity, entity_id, summary, details, actor, actor_role)
    SELECT 'payment.correct', 'payment', id::text, 'SYNTHETIC-UNRELATED', '{"synthetic":true}'::jsonb,
      'SYNTHETIC-UNRELATED', 'admin' FROM payments WHERE patient_id=$1`, [unrelatedPatient]);
  exact = await chain(); overflow = await chain(); multi = await chain();
  await filler([exact.patientId], 4_995, "PERF-EXACT");
  await filler([overflow.patientId], 4_996, "PERF-OVERFLOW");
  const otherPatients = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    SELECT 'PERF-MULTI-' || n::text, 'SYNTHETIC-RECEIPT-PERFORMANCE' FROM generate_series(1,999) n RETURNING id`)).map(row => row.id);
  await filler(otherPatients, 5, "PERF-MULTI");
  requestedMulti = [multi.receipts[2].id, ...(await q<{ id: number }>(`SELECT min(id) AS id FROM payments
    WHERE patient_id = ANY($1::int[]) GROUP BY patient_id ORDER BY patient_id`, [otherPatients])).map(row => row.id)];
  const counts = await q<{ patient_id: number; count: number }>(`SELECT patient_id, count(*)::int AS count FROM payments
    WHERE patient_id = ANY($1::int[]) GROUP BY patient_id`, [[exact.patientId, overflow.patientId, multi.patientId, ...otherPatients]]);
  expect(counts.find(row => row.patient_id === exact.patientId)?.count).toBe(5_000);
  expect(counts.find(row => row.patient_id === overflow.patientId)?.count).toBe(5_001);
  expect(counts.filter(row => row.patient_id !== exact.patientId && row.patient_id !== overflow.patientId)
    .reduce((sum, row) => sum + row.count, 0)).toBe(5_000);
  expect(requestedMulti).toHaveLength(1_000);
  expect(new Set(requestedMulti).size).toBe(1_000);
  fixtureCounts = { scopedPatients: counts.length, scopedPayments: counts.reduce((sum, row) => sum + row.count, 0),
    unrelatedPayments: Number((await q<{ count: string }>("SELECT count(*) AS count FROM payments WHERE patient_id=$1", [unrelatedPatient]))[0].count),
    unrelatedAudits: Number((await q<{ count: string }>("SELECT count(*) AS count FROM audit_log WHERE summary='SYNTHETIC-UNRELATED'"))[0].count) };
  expect(fixtureCounts).toEqual({ scopedPatients: 1_002, scopedPayments: 15_001, unrelatedPayments: 8_000, unrelatedAudits: 8_000 });
  // Explicit isolated-fixture statistics preparation, outside measured read-only
  // paths. No planner GUCs, forced scans, index/schema changes or latency SLA.
  await q("ANALYZE payments"); await q("ANALYZE audit_log");
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("actual receipt provenance SELECT plans at bounded scale", () => {
  it("measures exact 5000, neutral 5001 overflow, and 1000 IDs across 1000 patients without writes", async () => {
    const cases = [
      { name: "exact-5000-chain", ids: exact.receipts.map(row => row.id), contextRows: 5_000, selectRows: [5_000, 2] },
      { name: "overflow-5001-neutral", ids: overflow.receipts.map(row => row.id), contextRows: 5_001, selectRows: [5_001] },
      { name: "multi-1000-ids-5000-context", ids: requestedMulti, contextRows: 5_000, selectRows: [5_000, 2] },
    ];
    const results = [];
    for (const entry of cases) {
      const before = await snapshot(), pool = getPool(), originalConnect = pool.connect;
      const capture = await captureReceiptQueries(pool, () => readReceiptProvenance(entry.ids));
      expect(pool.connect).toBe(originalConnect);
      expect(capture.connections).toBe(1); expect(capture.releases).toBe(1);
      expect(capture.statements).toEqual(["begin", ...entry.selectRows.map(() => "select"), "commit"]);
      expect(capture.selects.map(row => row.rowCount)).toEqual(entry.selectRows);
      expect(capture.selects[0].parameters).toEqual([entry.ids, 5_001]);
      if (capture.selects.length === 2) {
        expect(capture.selects[1].parameters[0]).toHaveLength(4_998);
        expect(capture.selects[1].parameters[1]).toBe(5_001);
      }
      expect(Object.keys(capture.result).sort()).toEqual(entry.ids.map(String).sort());
      if (entry.name === "exact-5000-chain") assertChain(capture.result, exact);
      else if (entry.name === "overflow-5001-neutral") {
        for (const id of entry.ids) expect(capture.result[id]).toEqual(unavailableReceiptProvenance());
      } else {
        assertChain(capture.result, multi, true);
        for (const id of entry.ids.slice(1)) expect(capture.result[id]).toEqual({ status: "available",
          reversal: { state: "none", reversedMinor: 0, remainingMinor: 100 }, reversalOf: null, correction: null,
          correctionReversal: null, replacementOf: null, correctionUnverified: false });
      }
      for (const privateText of [PRIVATE_REASON, PRIVATE_ACTOR, "details", "actorRole", "summary", "PERF-UNRELATED"]) {
        expect(JSON.stringify(capture.result)).not.toContain(privateText);
      }
      expect(await snapshot()).toEqual(before);
      // Restored, real pool/client. Replays only actual captured SQL/parameters,
      // with the EXPLAIN prefix, in a separate read-only repeatable-read snapshot.
      const plans = await explainCapturedQueries(pool, capture.selects);
      expect(pool.connect).toBe(originalConnect);
      expect(await snapshot()).toEqual(before);
      results.push({ name: entry.name, requestedIds: entry.ids.length, distinctPatients: entry.name.startsWith("multi") ? 1_000 : 1,
        contextRows: entry.contextRows, selectCount: capture.selects.length, transactionStatements: capture.statements,
        connections: capture.connections, releases: capture.releases, instrumentedReaderElapsedMs: capture.elapsedMs,
        correctnessPassed: true, noWritesAfterReader: true, noWritesAfterExplain: true, plans });
    }
    const sourceFiles = [...Object.keys(SOURCE_HASHES), "__tests__/postgres/receipt-provenance-performance.test.ts",
      "__tests__/postgres/_receipt-query-evidence.ts", "__tests__/receipt-query-evidence.test.ts"];
    const evidence = { schema: "receipt-query-plan-v1", synthetic: true, allCasesPassed: true,
      repository: "Aqlanf10/aqlan-center-mini", baseSha: BASE,
      acceptedManifestSha256: "1477b771268f3ba7a3ac1547ff93d2965b2e32f18cb097169e3c4a6ca22344c9",
      acceptedDiffSha256: "06f3a940c7a55bde0b51fee503c6050ee13e115b31622211ff683ac6fc2e0b46",
      run: safeRunProvenance(process.env), serverVersionNum: serverVersion,
      sources: sourceFiles.map(path => ({ path, sha256: sha256(readFileSync(path)) })), fixtureCounts,
      fixtureStatistics: "ANALYZE payments; ANALYZE audit_log; before capture", plannerSettingsForced: false,
      measurement: "single instrumented read then EXPLAIN ANALYZE replay; warm cache possible; no latency SLA",
      results };
    // No evidence is emitted if any case, snapshot, capture, cleanup or replay fails.
    for (const frame of evidenceFrames(evidence)) console.log(frame);
  }, 180_000);
});
