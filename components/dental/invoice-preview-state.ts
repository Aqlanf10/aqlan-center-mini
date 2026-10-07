import { CLINIC_BASE_CURRENCY, parseAmount, type Currency } from "@/lib/money";

/** Preview evidence belongs to one exact request and to stable invoice row IDs. */
export interface LinePreview {
  line: number; kind: "financial" | "clinical"; specialtyLabel: string | null;
  item: { mode: "existing" | "new"; id: number | null } | null;
  case: { mode: "existing" | "new" | "bridge" | "choose" | "none"; id: number | null; title: string | null; options: { id: number; title: string }[] } | null;
  financialReviewRequired?: boolean;
  refusal: string | null;
  refusalMessage: string | null;
}

export type PreviewState = {
  requestKey: string;
  status: "pending" | "ready" | "unavailable" | "refused";
  message?: string;
  byRow: ReadonlyMap<string, LinePreview>;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === "string";
const idOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);

/** Reject missing/duplicate/reordered-invalid evidence rather than treating it as permission to save. */
export function readPreviewLines(payload: unknown, rows: readonly { key: string; clinical: boolean }[]): Map<string, LinePreview> | null {
  if (!object(payload) || !Array.isArray(payload.lines) || payload.lines.length !== rows.length) return null;
  const byRow = new Map<string, LinePreview>();
  for (const line of payload.lines) {
    if (!object(line) || typeof line.line !== "number" || !Number.isInteger(line.line)) return null;
    const row = rows[line.line];
    if (!row || byRow.has(row.key) || line.kind !== (row.clinical ? "clinical" : "financial")
      || (line.financialReviewRequired !== undefined && typeof line.financialReviewRequired !== "boolean")
      || !textOrNull(line.specialtyLabel) || !textOrNull(line.refusal) || !textOrNull(line.refusalMessage)) return null;
    const item = line.item;
    if (item !== null && (!object(item) || !["existing", "new"].includes(String(item.mode)) || !idOrNull(item.id))) return null;
    const clinicalCase = line.case;
    if (clinicalCase !== null && (!object(clinicalCase)
      || !["existing", "new", "bridge", "choose", "none"].includes(String(clinicalCase.mode))
      || !idOrNull(clinicalCase.id) || !textOrNull(clinicalCase.title) || !Array.isArray(clinicalCase.options)
      || !clinicalCase.options.every((option) => object(option) && option.id !== null && idOrNull(option.id) && typeof option.title === "string"))) return null;
    if (row.clinical && (typeof line.specialtyLabel !== "string" || item === null)) return null;
    if (row.clinical && line.refusal === null && line.refusalMessage === null) {
      // A successful preview must identify the plan/case decision, not just omit its refusal.
      if (!object(item) || !object(clinicalCase) || (item.mode === "existing" && item.id === null)
        || (item.mode === "new" && item.id !== null)
        || (clinicalCase.mode === "existing" && clinicalCase.id === null)) return null;
    }
    byRow.set(row.key, line as unknown as LinePreview);
  }
  return byRow;
}

export function previewForRow(state: PreviewState | null, requestKey: string, rowKey: string):
  | { status: "pending" | "unavailable" | "refused"; line: null; message?: string }
  | { status: "ready" | "refused"; line: LinePreview; message?: string } {
  if (!state || state.requestKey !== requestKey || state.status === "pending") return { status: "pending", line: null };
  if (state.status === "refused") return { status: "refused", line: null, message: state.message };
  const line = state.byRow.get(rowKey);
  if (state.status === "unavailable" || !line) return { status: "unavailable", line: null };
  return { status: line.refusal || line.refusalMessage || line.case?.mode === "choose" ? "refused" : "ready", line };
}

/** Same valid price/quantity normalization as invoice save; invalid text is never substituted. */
export function invoiceLineInputProblem(input: {
  price: string; quantity: string; currency: Currency; servicePriceMinor: number | null;
}): string | null {
  const quantity = Math.max(1, Math.round(Number(input.quantity)));
  if (!Number.isFinite(quantity) || quantity > 999) return "اكتب كمية صحيحة لا تتجاوز 999.";
  if (!input.price.trim()) {
    if (input.currency !== CLINIC_BASE_CURRENCY) return "اكتب سعر البند صراحةً بعملة الفاتورة المختارة.";
    if (input.servicePriceMinor === null) return "اكتب سعرًا صحيحًا للبند.";
  } else if (parseAmount(input.price, input.currency) === null) return "اكتب سعرًا صحيحًا للبند.";
  return null;
}
