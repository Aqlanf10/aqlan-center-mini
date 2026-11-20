import { expect, it, vi } from "vitest";
import { PATIENT_NUMBER_SQL } from "../lib/document-numbers";
import { patientNumberingInsertValue, withPatientNumberingInsertScope } from "../lib/patient-numbering-insert-scope";
const client = { query: vi.fn(async () => ({ rows: [] })) };

it("keeps original SQL and query count exactly when no installer exists", async () => {
  expect(await patientNumberingInsertValue(client, 15)).toEqual({ sql: PATIENT_NUMBER_SQL, values: [] });
  expect(client.query).not.toHaveBeenCalled();
});
it("binds the scoped identifier as a value without contaminating other requests", async () => {
  const configured = withPatientNumberingInsertScope(async chosen => {
    expect(chosen).toBe(client); return "A-01500";
  }, () => patientNumberingInsertValue(client, 15));
  expect(await patientNumberingInsertValue(client, 15)).toEqual({ sql: PATIENT_NUMBER_SQL, values: [] });
  expect(await configured).toEqual({ sql: "$15::text", values: ["A-01500"] });
});
it("refuses corrupt allocation rather than falling back to P", async () => {
  await expect(withPatientNumberingInsertScope(async () => "A-1500", () => patientNumberingInsertValue(client, 15)))
    .rejects.toThrow("Invalid allocated patient identifier");
});
it("disallows a detached callback from allocating after the importing request completes", async () => {
  let attempt: Promise<unknown> | undefined;
  const allocate = vi.fn(async () => "A-01500");
  await withPatientNumberingInsertScope(allocate, async () => {
    attempt = new Promise((resolve, reject) => {
      setTimeout(() => { void patientNumberingInsertValue(client, 3).then(resolve, reject); }, 5);
    });
  });
  await expect(attempt).rejects.toThrow("Invalid or expired patient numbering context");
  expect(allocate).not.toHaveBeenCalled();
});
