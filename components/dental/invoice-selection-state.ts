import { readPreviewLines, type PreviewState } from "./invoice-preview-state";

export interface InvoicePlanChoice { id: number; compatible: boolean }
export interface InvoiceItemChoice { id: number; planId: number; clinicalCaseId: number | null }
export interface InvoiceSelectionEvidence {
  planChoices: InvoicePlanChoice[];
  itemChoices: ReadonlyMap<string, InvoiceItemChoice[]>;
}
export type InvoiceSelectionPreviewState = PreviewState & { selections?: InvoiceSelectionEvidence };
export interface InvoiceSelection {
  /** Reference identity, not a reusable serialized key. */
  owner: object;
  existingPlanId: number | null;
  itemIds: ReadonlyMap<string, number>;
}
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyIds: ReadonlyMap<string, number> = new Map();
export function selectionForOwner(selection: InvoiceSelection | null, owner: object) {
  return selection?.owner === owner ? selection : { owner, existingPlanId: null, itemIds: emptyIds };
}

/** New selections can only use current canonical candidates. Neither action chooses the first row. */
export function selectInvoicePlan(selection: InvoiceSelection | null, owner: object, planId: number | null, choices: readonly InvoicePlanChoice[]): InvoiceSelection | null {
  if (planId !== null && !choices.some((choice) => choice.id === planId && choice.compatible)) return null;
  const current = selectionForOwner(selection, owner);
  return { owner, existingPlanId: planId, itemIds: planId === current.existingPlanId ? current.itemIds : new Map() };
}
export function selectInvoiceItem(selection: InvoiceSelection | null, owner: object, rowKey: string, itemId: number | null, choices: readonly InvoiceItemChoice[]): InvoiceSelection | null {
  const current = selectionForOwner(selection, owner);
  if (itemId !== null && !choices.some((choice) => choice.id === itemId
    && (current.existingPlanId === null || choice.planId === current.existingPlanId))) return null;
  const itemIds = new Map(current.itemIds);
  if (itemId === null) itemIds.delete(rowKey); else itemIds.set(rowKey, itemId);
  return { owner, existingPlanId: current.existingPlanId, itemIds };
}

/** A response must identify the requested selections and preserve stable row ownership. */
export function readInvoiceSelectionPreview(payload: unknown,
  rows: readonly { key: string; clinical: boolean; planItemId?: number | null }[], existingPlanId: number | null) {
  const byRow = readPreviewLines(payload, rows);
  if (!byRow || !object(payload) || payload.existingPlanId !== existingPlanId || !Array.isArray(payload.planChoices)
    || !Array.isArray(payload.lines)) return null;
  const planChoices: InvoicePlanChoice[] = [];
  for (const choice of payload.planChoices) {
    if (!object(choice) || !id(choice.id) || typeof choice.compatible !== "boolean"
      || planChoices.some((other) => other.id === choice.id)) return null;
    planChoices.push({ id: choice.id, compatible: choice.compatible });
  }
  const itemChoices = new Map<string, InvoiceItemChoice[]>();
  for (const line of payload.lines) {
    if (!object(line) || typeof line.line !== "number") return null;
    const request = rows[line.line];
    if (!request) return null;
    // Do not inherit the legacy decoder's String(mode) coercion. These are
    // discriminants, and each mode has a precise persisted-ID relationship.
    const item = line.item;
    if (item !== null && (!object(item) || typeof item.mode !== "string"
      || !["existing", "new"].includes(item.mode)
      || (item.mode === "existing" ? !id(item.id) : item.id !== null))) return null;
    const clinicalCase = line.case;
    if (clinicalCase !== null && (!object(clinicalCase) || typeof clinicalCase.mode !== "string"
      || !["existing", "new", "bridge", "choose", "none"].includes(clinicalCase.mode)
      || (clinicalCase.mode === "existing" ? !id(clinicalCase.id) : clinicalCase.id !== null))) return null;
    // Early site-validation refusals and financial-only lines have no inspected work candidates.
    const candidates = line.itemCandidates === undefined && (line.kind === "financial" || line.refusal !== null)
      ? [] : line.itemCandidates;
    if (!Array.isArray(candidates)) return null;
    const parsed: InvoiceItemChoice[] = [];
    for (const candidate of candidates) {
      if (!object(candidate) || !id(candidate.id) || !id(candidate.planId)
        || !(candidate.clinicalCaseId === null || id(candidate.clinicalCaseId))
        || parsed.some((other) => other.id === candidate.id)) return null;
      parsed.push({ id: candidate.id, planId: candidate.planId, clinicalCaseId: candidate.clinicalCaseId });
    }
    if (line.kind === "financial" && (item !== null || clinicalCase !== null || parsed.length !== 0)) return null;
    if (line.kind === "clinical" && line.refusal === null && line.refusalMessage === null) {
      if (!object(item) || !object(clinicalCase) || clinicalCase.mode === "choose") return null;
      if (item.mode === "existing" && !parsed.some((candidate) => candidate.id === item.id
        && (existingPlanId === null || candidate.planId === existingPlanId)
        // Restorative services can retain an item case while the canonical
        // preview makes no case decision (needsCase=false). Do not erase it.
        && (candidate.clinicalCaseId === null || clinicalCase.mode === "none" || clinicalCase.mode === "existing"
          && candidate.clinicalCaseId === clinicalCase.id))) return null;
    }
    if (line.kind === "clinical" && line.refusal === null && existingPlanId !== null) {
      const plan = planChoices.find((choice) => choice.id === existingPlanId);
      if (!plan || object(line.item) && line.item.mode === "new" && !plan.compatible) return null;
    }
    if (line.refusal === null && request.planItemId != null) {
      if (!object(line.item) || line.item.mode !== "existing" || line.item.id !== request.planItemId
        || !parsed.some((candidate) => candidate.id === request.planItemId
          && (existingPlanId === null || candidate.planId === existingPlanId))) return null;
    }
    itemChoices.set(request.key, parsed);
  }
  return { byRow, selections: { planChoices, itemChoices } };
}
