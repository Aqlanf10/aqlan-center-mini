import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAB_SHADE_SPECIFICATION_SQL } from "../lib/lab-shade-schema";
import { LAB_SHADE_CODES, parseLabShadeSpecification } from "../lib/lab-shades";
import { ALL_TEETH } from "../lib/dental";

const tooth = (toothCode = 11) => ({ toothCode, cervical: null, body: { guide: "vita_classical", code: "A2" }, incisal: null });
const spec = () => ({ version: 1, teeth: [tooth()] });

describe("lab shade migration on an isolated SQL engine", () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec("CREATE TABLE lab_orders (id INTEGER PRIMARY KEY, shade TEXT, tooth_numbers TEXT); INSERT INTO lab_orders VALUES (1, 'OM3', '11(Crown)');");
    await db.exec(LAB_SHADE_SPECIFICATION_SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("keeps the reviewed migration byte-identical to runtime SQL", () => {
    expect(readFileSync(new URL("../migrations/0089_lab_shade_specification.sql", import.meta.url), "utf8")).toBe(LAB_SHADE_SPECIFICATION_SQL);
  });

  it("adds nullable structured data without changing legacy shades or tooth roles", async () => {
    expect((await db.query("SELECT * FROM lab_orders WHERE id=1")).rows).toEqual([
      { id: 1, shade: "OM3", tooth_numbers: "11(Crown)", shade_specification: null },
    ]);
    await db.query("UPDATE lab_orders SET shade_specification=$1::jsonb WHERE id=1", [JSON.stringify(spec())]);
    expect((await db.query("SELECT shade_specification FROM lab_orders WHERE id=1")).rows).toEqual([{ shade_specification: spec() }]);
    await db.query("UPDATE lab_orders SET shade_specification=NULL WHERE id=1");
  });

  it("accepts all official shade codes and FDI identities with parity to the typed boundary", async () => {
    const values: unknown[] = [null, { version: 1, teeth: [] }, { version: 1, teeth: ALL_TEETH.map(tooth) }];
    for (const [guide, codes] of Object.entries(LAB_SHADE_CODES)) {
      for (const code of codes) values.push({ version: 1, teeth: [{ ...tooth(), body: { guide, code } }] });
    }
    for (const value of values) {
      expect(parseLabShadeSpecification(value).ok).toBe(true);
      const result = await db.query<{ valid: boolean }>("SELECT aqlan_valid_lab_shade_specification($1::jsonb) AS valid", [value === null ? null : JSON.stringify(value)]);
      expect(result.rows[0].valid).toBe(true);
    }
  });

  it("rejects malformed JSON shapes and codes rather than passing SQL NULL checks", async () => {
    const invalid: unknown[] = [
      "null", {}, [], "text", 1, true,
      { version: null, teeth: [] }, { version: "1", teeth: [] }, { version: 2, teeth: [] },
      { version: 1, teeth: null }, { version: 1 }, { teeth: [] }, { ...spec(), patientName: "PRIVATE_CANARY" },
      { version: 1, teeth: [null] }, { version: 1, teeth: [{ toothCode: 11 }] },
      { version: 1, teeth: [tooth(), tooth()] },
      ...[19, 20, 56, 86, 0, 99, 11.5, "11", null].map(toothCode => ({ version: 1, teeth: [{ ...tooth(), toothCode }] })),
      ...[{}, [], "A2", { guide: null, code: "A2" }, { guide: "vita_classical", code: null }, { guide: "vita_classical" },
        { code: "A2" }, { guide: "vita_classical", code: "0M3" }, { guide: "vita_3d_master", code: "OM3" },
        { guide: "vita_classical", code: "A2", note: "PRIVATE_CANARY" }].map(body => ({ version: 1, teeth: [{ ...tooth(), body }] })),
    ];
    for (const value of invalid) {
      expect(parseLabShadeSpecification(value).ok, JSON.stringify(value)).toBe(false);
      const result = await db.query<{ valid: boolean }>("SELECT aqlan_valid_lab_shade_specification($1::jsonb) AS valid", [JSON.stringify(value)]);
      expect(result.rows[0].valid, JSON.stringify(value)).toBe(false);
    }
    expect((await db.query<{ valid: boolean }>("SELECT aqlan_valid_lab_shade_specification('null'::jsonb) AS valid")).rows[0].valid).toBe(false);
    await expect(db.query("UPDATE lab_orders SET shade_specification=$1::jsonb WHERE id=1", [JSON.stringify({ version: 1, teeth: [{ ...tooth(), body: { guide: "vita_3d_master", code: "OM3" } }] })])).rejects.toThrow(/lab_orders_shade_specification_valid/);
    expect((await db.query("SELECT shade, shade_specification FROM lab_orders WHERE id=1")).rows).toEqual([{ shade: "OM3", shade_specification: null }]);
  });
});
