import { expect, it } from "vitest";
import { patientNumberBackupSql } from "../lib/patient-number-backup-sql";
import { managedPatientNumberRestoreGuard, patientNumberRestoreGuard, prepareBackupSql } from "../lib/restore/sql.mjs";

it("uses the existing SQL entrypoint grammar and preserves bigint decimals as text", () => {
  const point = patientNumberBackupSql("9223372036854775807", false);
  const sql = "BEGIN;\n" + point + "\nCOMMIT;\n";
  const p = prepareBackupSql(sql);
  expect(p.sql).toBe(sql);
  expect(p.dataSql.trim()).toBe(point);
  expect(point).toContain("RESTART WITH 9223372036854775807;");
  expect(point).toContain("AND false");
  expect(point).not.toMatch(/\bsetval\(/i);
});

it.each([
  [9007199254740992, true],
  ["0", false],
  ["01", true],
  ["-1", false],
  ["9223372036854775808", true],
  ["9007199254740993\n", true],
  ["1; SELECT 1", false],
  ["1", "false"],
  ["1", null],
])("rejects malformed cursor fields %s %s", (last, called) => {
  expect(() => patientNumberBackupSql(last, called)).toThrow("Invalid patient-number sequence snapshot");
});

it.each([true, false])("preserves the source's managed restore requirement when managed=%s", (managed) => {
  // An empty roster, no policy row and a pending P-07000 have identical data
  // in the two profiles. Only the source-generated schema guard distinguishes them.
  const body = [
    patientNumberRestoreGuard(true),
    ...(managed ? [managedPatientNumberRestoreGuard] : []),
    "SELECT setval(pg_get_serial_sequence('patients', 'id'), 1, false);",
    patientNumberBackupSql("7000", false),
  ].join("\n");
  const sql = "BEGIN;\n" + body + "\nCOMMIT;";
  const prepared = prepareBackupSql(sql);
  expect(prepared.sql).toBe(sql);
  expect(prepared.dataSql.trim()).toBe(body);
});
