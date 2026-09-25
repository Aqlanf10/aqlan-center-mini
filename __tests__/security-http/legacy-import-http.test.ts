import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";
import { readFirstSheet, rowsToCsv } from "../../lib/xlsx-reader";

/**
 * (P1-5c) Old-system treatments and payments through the real route — synthetic
 * fixtures: admin only, preview writes nothing, unmatched rows are assigned by the
 * owner, balances land in their own currency, the archive is readable in the file.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const ids: Record<string, number> = {};
let treatmentsCsv = "";
let sessionsCsv = "";

const csvOf = async (name: string) => rowsToCsv(await readFirstSheet(
  new Uint8Array(readFileSync(`__tests__/fixtures/${name}`)), async (bytes) => new Uint8Array(inflateRawSync(bytes))));

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  for (const [key, name, phone] of [["salem", "سالم تجربة احمد", "967771000001"], ["mona", "منى تجربة سعيد", null], ["other", "مراد تجربة", null]] as const) {
    ids[key] = (await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id`,
      [`LEG-${key}-${Date.now()}`, name, phone])).rows[0].id;
  }
  treatmentsCsv = await csvOf("old-treatments.xlsx");
  sessionsCsv = await csvOf("old-sessions.xlsx");
}, 120_000);
afterAll(async () => { await db?.end(); });

const post = (session: Parameters<typeof authedMutation>[1], body: Record<string, unknown>) =>
  authedMutation("/api/patients/import/legacy", session, "POST", JSON.stringify({ treatmentsCsv, sessionsCsv, ...body }));

describe("POST /api/patients/import/legacy", () => {
  it("is admin-only", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorA]) {
      expect((await post(session, { mode: "preview" })).status).toBe(403);
    }
  });

  it("previews without writing, lists the unmatched row, then commits with the owner's assignment", async () => {
    const preview = await post(h.sessions.admin, { mode: "preview" });
    expect(preview.status).toBe(200);
    const body = await preview.json() as { fileSha256: string; unresolved: { legacyNumber: number }[]; summary: { treatmentsMatched: number } };
    expect(body.unresolved.map((row) => row.legacyNumber)).toEqual([4]);
    expect((await db.query(`SELECT 1 FROM legacy_treatments`)).rowCount).toBe(0);

    const commit = await post(h.sessions.admin, { mode: "commit", fileSha256: body.fileSha256, assignments: { 4: ids.other } });
    expect(commit.status).toBe(201);
    expect(await commit.json()).toMatchObject({ treatments: 5, sessions: 2, skippedTreatments: 0 });

    const ledger = await (await authedGet(`/api/patients/${ids.salem}/ledger`, h.sessions.admin)).json() as { balances: Record<string, { dueMinor: number }> };
    expect(ledger.balances.SAR.dueMinor).toBe(167122);
    expect(ledger.balances.USD.dueMinor).toBe(10000);

    const history = await (await authedGet(`/api/patients/${ids.salem}/legacy`, h.sessions.reception)).json() as { treatments: { legacyNumber: number }[] };
    expect(history.treatments.map((row) => row.legacyNumber)).toEqual([1, 3, 5]);
    expect((await authedGet(`/api/patients/${ids.salem}/legacy`, h.sessions.doctorB)).status).toBe(404);

    const again = await post(h.sessions.admin, { mode: "commit", fileSha256: body.fileSha256 });
    expect(again.status).toBe(409);
  });
});
