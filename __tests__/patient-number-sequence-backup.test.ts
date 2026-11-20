import { describe, expect, it } from "vitest";
import { patientNumberSequenceBackupLine, patientNumberSequenceMarker as marker } from "../lib/restore/patient-number-sequence.mjs";
import { prepareBackupSql } from "../lib/restore/sql.mjs";

describe("legacy patient-number sequence backup metadata", () => {
  it("preserves exact bigint and called/pending without changing replay SQL", () => {
    const line = patientNumberSequenceBackupLine("9223372036854775807", false);
    const sql = `BEGIN;\n${line}COMMIT;\n`;
    expect(prepareBackupSql(sql)).toMatchObject({
      sql, patientNumberSequence: { lastValue: "9223372036854775807", isCalled: false },
      sqlRowsStatementLines: 0,
    });
  });
  it.each([
    "9223372036854775808", "0900000", "1e6", "0", "-1", "١", "1;SELECT",
  ])("rejects malformed source/restore value %s", (value) => {
    expect(() => patientNumberSequenceBackupLine(value, true)).toThrow();
    expect(() => prepareBackupSql(`BEGIN;\n${marker} ${value} true\nCOMMIT;\n`)).toThrow();
  });
  it("does not treat strings or block comments as archive metadata", () => {
    const sql = `BEGIN;\n/* ${marker} 20 false */\nINSERT INTO patients VALUES('X\n${marker} 19 true\nY');\nCOMMIT;\n`;
    expect(prepareBackupSql(sql)).toMatchObject({ sql, patientNumberSequence: null });
  });
  it.each([
    `BEGIN;\n${marker} 10 true\n${marker} 10 true\nCOMMIT;`,
    `BEGIN;\n${marker} 10 true\nINSERT INTO settings VALUES('a');\nCOMMIT;`,
    `BEGIN;\nCOMMIT;\n${marker} 10 true\n`,
    `BEGIN;\nSELECT 1 ${marker} 10 true\n;\nCOMMIT;`,
    `BEGIN;\n${marker} 10 1\nCOMMIT;`,
    `BEGIN; ${marker} 10 true\nCOMMIT;`,
    `BEGIN;\n${marker.replace("v1", "v2")} 10 true\nCOMMIT;`,
  ])("rejects duplicate, misplaced or malformed marker", (sql) => {
    expect(() => prepareBackupSql(sql)).toThrow();
  });
  it("does not infer a snapshot from an old archive", () => {
    expect(prepareBackupSql("BEGIN;\nCOMMIT;").patientNumberSequence).toBeNull();
  });
  it("does not accept dollar-quoted executable metadata", () => {
    expect(() => prepareBackupSql("BEGIN; DO $$ BEGIN END $$; COMMIT;")).toThrow();
  });
});
