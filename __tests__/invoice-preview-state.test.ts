import { describe, expect, it } from "vitest";
import { invoiceLineInputProblem, previewForRow, readPreviewLines, type LinePreview, type PreviewState } from "../components/dental/invoice-preview-state";

const clinical = (line = 0): LinePreview => ({ line, kind: "clinical", specialtyLabel: "عصب",
  item: { mode: "new", id: null }, case: { mode: "new", id: null, title: null, options: [] },
  refusal: null, refusalMessage: null });
const ready = (requestKey = "patient-1:row-A:tooth-36"): PreviewState => ({
  requestKey, status: "ready", byRow: new Map([["row-A", clinical()]]),
});

describe("invoice preview evidence ownership", () => {
  it("invalidates success synchronously for another tooth, service, price, currency, case, or patient request", () => {
    const state = ready();
    for (const key of ["tooth-46", "service-2", "price-2", "currency-SAR", "case-9", "patient-2"]) {
      expect(previewForRow(state, key, "row-A")).toEqual({ status: "pending", line: null });
    }
  });
  it("never transfers line zero success to a replacement row at the same index", () => {
    expect(previewForRow(ready(), ready().requestKey, "row-B")).toEqual({ status: "unavailable", line: null });
  });
  it("maps unordered response indices to stable row keys, without making array order the identity", () => {
    const rows = [{ key: "row-A", clinical: true }, { key: "row-B", clinical: true }];
    const second = { ...clinical(1), item: { mode: "existing" as const, id: 92 } };
    const result = readPreviewLines({ lines: [second, clinical(0)] }, rows);
    expect(result?.get("row-B")).toEqual(second);
    expect(result?.get("row-A")?.line).toBe(0);
  });
  it("rejects missing, duplicate, extra, wrong-kind, and malformed evidence", () => {
    const rows = [{ key: "row-A", clinical: true }, { key: "row-B", clinical: true }];
    for (const lines of [[], [clinical()], [clinical(), clinical()], [clinical(), clinical(3)],
      [clinical(), { ...clinical(1), kind: "financial" }],
      [clinical(), { ...clinical(1), case: { mode: "new", options: "bad" } }],
      [clinical(), { ...clinical(1), item: null }], [clinical(), { ...clinical(1), case: null }],
      [clinical(), { ...clinical(1), item: { mode: "existing", id: null } }],
      [clinical(), { ...clinical(1), refusal: undefined }]]) {
      expect(readPreviewLines({ lines }, rows)).toBeNull();
    }
    expect(readPreviewLines(null, rows)).toBeNull();
  });
  it("pending and unavailable states cannot reuse retained evidence", () => {
    for (const status of ["pending", "unavailable"] as const) {
      const state = { ...ready(), status };
      expect(previewForRow(state, state.requestKey, "row-A")).toEqual({ status, line: null });
    }
  });
  it("a refusal code blocks saving even when its Arabic message is missing", () => {
    const state = ready();
    state.byRow = new Map([["row-A", { ...clinical(), refusal: "already_billed" }]]);
    expect(previewForRow(state, state.requestKey, "row-A").status).toBe("refused");
  });
  it("an unresolved case choice cannot be treated as successful permission to save", () => {
    const state = ready();
    state.byRow = new Map([["row-A", { ...clinical(), case: { mode: "choose", id: null, title: null, options: [{ id: 10, title: "حالة" }] } }]]);
    expect(previewForRow(state, state.requestKey, "row-A").status).toBe("refused");
  });
  it("accepts complete financial-only evidence without manufacturing clinical linkage", () => {
    const line: LinePreview = { line: 0, kind: "financial", specialtyLabel: null, item: null, case: null, refusal: null, refusalMessage: null };
    expect(readPreviewLines({ lines: [line] }, [{ key: "manual", clinical: false }])?.get("manual")).toEqual(line);
  });
});

describe("invoice preview raw-input validation", () => {
  it.each([
    { price: "abc", quantity: "1", currency: "YER" as const, servicePriceMinor: 500 },
    { price: "", quantity: "1", currency: "SAR" as const, servicePriceMinor: 500 },
    { price: "", quantity: "1", currency: "USD" as const, servicePriceMinor: 500 },
    { price: "500", quantity: "1000", currency: "YER" as const, servicePriceMinor: 500 },
    { price: "500", quantity: "NaN", currency: "YER" as const, servicePriceMinor: 500 },
  ])("does not manufacture a successful preview for invalid inputs %j", (input) => {
    expect(invoiceLineInputProblem(input)).not.toBeNull();
  });
  it("preserves valid base catalogue fallback and the existing finite rounded quantity policy", () => {
    for (const quantity of ["", "0", "-2", "1.5", "999"]) {
      expect(invoiceLineInputProblem({ price: "", quantity, currency: "YER", servicePriceMinor: 500 })).toBeNull();
    }
    expect(invoiceLineInputProblem({ price: "12.50", quantity: "2", currency: "SAR", servicePriceMinor: 500 })).toBeNull();
  });
});

it("keeps an actionable current-request parser refusal without any successful line evidence", () => {
  const state: PreviewState = { requestKey: "current", status: "refused", message: "اكتب سبب الخصم.", byRow: new Map() };
  expect(previewForRow(state, "current", "row-A")).toEqual({ status: "refused", line: null, message: "اكتب سبب الخصم." });
  expect(previewForRow(state, "changed", "row-A")).toEqual({ status: "pending", line: null });
});
