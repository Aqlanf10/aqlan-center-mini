import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalOrthoStrategyCommand as parse } from "../lib/canonical-ortho-strategy-command";
import { OrthoStrategyStoreFault } from "../lib/ortho-treatment-strategy-store";
const command = () => ({ schemaVersion: 1, commandId: "synthetic_strategy_command_001", expectedRevisionId: null,
  reason: "SYN explicit documentation", rows: [{ problemId: 11, objective: "SYN objective", strategy: "SYN authored strategy", rationale: null, planItemIds: [17] }] });
it("retains the existing strict clinical command and request identity", () => { const input = command(); expect(parse("23", input)).toEqual({ id: 23, command: input }); });
it.each(["0", "01", "-1", "1.2", "1e2", "2147483648", "1x"])("refuses ambiguous case identity %s", id => { expect(() => parse(id, command())).toThrow(OrthoStrategyStoreFault); });
it.each([{ schemaVersion: 2 }, { schemaVersion: [1] }, { actor: "owner" }, { force: true }, { patientId: 3 },
  { commandId: [] }, { commandId: "short" }, { expectedRevisionId: "1" }, { expectedRevisionId: 0 },
  { reason: ["SYN"] }, { reason: {} }, { reason: "" }, { rows: [] }, { rows: {} }])("rejects coerced, incomplete or authority-bearing request %#", patch => {
  expect(() => parse("23", { ...command(), ...patch })).toThrow(OrthoStrategyStoreFault);
});
it.each([{ problemId: "11" }, { planItemIds: "17" }, { planItemIds: [17, 17] }, { objective: ["SYN"] }, { strategy: {} }, { unitPriceMinor: 1 }])("rejects invalid or financial row fields %#", patch => {
  const input = command(); expect(() => parse("23", { ...input, rows: [{ ...input.rows[0], ...patch }] })).toThrow(OrthoStrategyStoreFault);
});
it.each([null, [], "{}", 17])("rejects non-object request %#", body => { expect(() => parse("23", body)).toThrow(OrthoStrategyStoreFault); });
