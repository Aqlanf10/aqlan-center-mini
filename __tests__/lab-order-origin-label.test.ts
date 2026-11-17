import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { labOrderOriginLabel } from "../lib/lab-order-origin";

describe("truthful laboratory origin labels", () => {
  it("does not call an invoice-created unsent order a signed visit", () => {
    expect(labOrderOriginLabel({ source: "manual", visitId: null })).toBeNull();
  });
  it("retains the verified automatic visit origin", () => {
    expect(labOrderOriginLabel({ source: "auto", visitId: 42 })).toBe("من الزيارة");
  });
  it("does not infer origin from a linked visit or incomplete legacy metadata", () => {
    for (const order of [
      { source: "manual" as const, visitId: 42 },
      { source: null, visitId: 42 },
      { source: "auto" as const, visitId: null },
      { source: "auto" as const, visitId: 0 },
    ]) expect(labOrderOriginLabel(order)).toBeNull();
  });
  it("keeps unsent status neutral in both laboratory screens", () => {
    for (const file of ["app/lab/page.tsx", "components/PatientLabOrders.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("لم يُرسل بعد — من إجراء الزيارة");
      expect(source).not.toContain("أُنشئ من توقيع الزيارة");
      expect(source).toContain("لم يُرسل بعد");
    }
    const board = readFileSync("app/lab/page.tsx", "utf8");
    expect(board).toContain("labOrderOriginLabel(order)");
  });
});
