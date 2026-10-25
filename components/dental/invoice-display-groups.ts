/**
 * Invoice creation editor projections only. Canonical rows remain one per tooth;
 * none of these display identities belong in a saved invoice or clinical payload.
 */
import { isValidTooth } from "@/lib/dental";
import { CLINIC_BASE_CURRENCY, parseAmount, type Currency } from "@/lib/money";
import type { ToothScopeMode } from "@/lib/invoice-clinical-linkage";
import {
  applyToothSelection, removeRowAt, replaceRowService,
  type ToothRowLike, type ToothSelection,
} from "./invoice-tooth-selection";

export interface InvoiceDisplayRowLike extends ToothRowLike {
  displayGroupId?: string | null;
  serviceId: string;
  doctorId: string;
  price: string;
  quantity: string;
  priceReason: string;
  description?: string;
  manual?: boolean;
  planItemId?: number | string | null;
}

export interface InvoiceDisplayGroupingContext<R extends InvoiceDisplayRowLike> {
  currency?: Currency;
  /** Return integer minor units; invalid/unknown prices must return null. */
  priceValue?: (row: R, index: number) => number | null;
  /** Plan/source identity, not the independent per-tooth case or plan-item ID. */
  provenance?: (row: R, index: number) => string | null | undefined;
  /** Optional explicit subgroup being edited by the tooth dialog. */
  memberKeys?: readonly string[];
}

export interface InvoiceDisplayGroup<R extends InvoiceDisplayRowLike> {
  /** Stable representative canonical key; never an array position. */
  key: string;
  row: R;
  indices: number[];
  keys: string[];
  teeth: number[];
  /** Number of canonical children, not an editable clinical quantity. */
  quantity: number;
  /** Both amounts are integer minor units, or null if not safely readable. */
  unitPrice: number | null;
  total: number | null;
  grouped: boolean;
}

const sortedTeeth = (teeth: readonly number[]) => [...new Set(teeth)].sort((a, b) => a - b);
const validAmount = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
const quantityOf = (row: InvoiceDisplayRowLike): number | null => {
  const value = row.quantity.trim() ? Number(row.quantity) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

function priceOf<R extends InvoiceDisplayRowLike>(row: R, index: number, context: InvoiceDisplayGroupingContext<R>): number | null {
  const value = context.priceValue ? context.priceValue(row, index) : parseAmount(row.price, context.currency ?? CLINIC_BASE_CURRENCY);
  return validAmount(value) ? value : null;
}

/** Explicit display intent plus compatible financial, clinical and source state. */
function signatureOf<R extends InvoiceDisplayRowLike>(row: R, index: number, price: number | null, context: InvoiceDisplayGroupingContext<R>): string | null {
  if (!row.displayGroupId || !row.serviceId || row.toothCode === null || !isValidTooth(row.toothCode)
    || row.scope !== null || quantityOf(row) !== 1) return null;
  return JSON.stringify([
    row.displayGroupId, row.serviceId, row.doctorId, price === null ? ["unreadable", row.price] : ["minor", price], row.priceReason, row.manual === true,
    row.description ?? "", row.surfaces, row.scope, row.groupId,
    row.episodeTeeth === null ? null : sortedTeeth(row.episodeTeeth),
    context.provenance?.(row, index) ?? null,
  ]);
}

export function buildInvoiceDisplayGroups<R extends InvoiceDisplayRowLike>(
  rows: readonly R[], context: InvoiceDisplayGroupingContext<R> = {},
): InvoiceDisplayGroup<R>[] {
  const groups: InvoiceDisplayGroup<R>[] = [];
  const bySignature = new Map<string, InvoiceDisplayGroup<R>>();
  rows.forEach((row, index) => {
    const unitPrice = priceOf(row, index, context);
    const quantity = quantityOf(row);
    const amount = unitPrice !== null && quantity !== null ? unitPrice * quantity : null;
    const total = validAmount(amount) ? amount : null;
    const signature = signatureOf(row, index, unitPrice, context);
    const candidate = signature === null ? undefined : bySignature.get(signature);
    // A duplicate tooth is never hidden inside a display group.
    if (candidate && row.toothCode !== null && !candidate.teeth.includes(row.toothCode)) {
      const sum = candidate.total !== null && total !== null ? candidate.total + total : null;
      // Keep an explicit batch intact while replacing a price input's text. Its
      // exact unreadable draft must match and no numeric total is invented.
      if (validAmount(sum) || candidate.unitPrice === null && unitPrice === null) {
        candidate.indices.push(index); candidate.keys.push(row.key); candidate.teeth.push(row.toothCode);
        candidate.teeth.sort((a, b) => a - b);
        candidate.quantity = candidate.keys.length; candidate.total = sum; candidate.grouped = true;
        return;
      }
    }
    const group: InvoiceDisplayGroup<R> = {
      key: row.key, row, indices: [index], keys: [row.key], teeth: row.toothCode === null ? [] : [row.toothCode],
      quantity: 1, unitPrice, total, grouped: false,
    };
    groups.push(group);
    if (signature !== null && !candidate) bySignature.set(signature, group);
  });
  return groups;
}

/** A split bridge child opens with its own tooth, not the entire clinical episode. */
export function selectionOfDisplayGroup<R extends InvoiceDisplayRowLike>(group: InvoiceDisplayGroup<R>): ToothSelection {
  return { teeth: [...group.teeth], surfaces: group.row.surfaces, scope: group.row.scope };
}

function compatibleKeys<R extends InvoiceDisplayRowLike>(rows: readonly R[], keys: readonly string[], context: InvoiceDisplayGroupingContext<R>): Set<string> {
  const requested = new Set(keys);
  const first = rows.find(row => requested.has(row.key));
  const group = first && buildInvoiceDisplayGroups(rows, context).find(one => one.keys.includes(first.key));
  return new Set(group?.keys.filter(key => requested.has(key)) ?? []);
}

/** Recheck compatibility when applying a potentially stale rendered group edit. */
export function patchDisplayGroupRows<R extends InvoiceDisplayRowLike>(
  rows: readonly R[], keys: readonly string[], patch: Partial<Pick<R, "price" | "doctorId" | "priceReason" | "description" | "quantity">>,
  context: InvoiceDisplayGroupingContext<R> = {},
): R[] {
  const members = compatibleKeys(rows, keys, context);
  return rows.map(row => members.has(row.key) ? { ...row, ...patch } : row);
}

export function removeDisplayGroupRows<R extends InvoiceDisplayRowLike>(
  rows: readonly R[], keys: readonly string[], context: InvoiceDisplayGroupingContext<R> = {},
): R[] {
  const members = compatibleKeys(rows, keys, context);
  let result = [...rows];
  for (let index = result.length - 1; index >= 0; index--) {
    if (members.has(result[index].key)) result = removeRowAt(result, index);
  }
  return result;
}

/** A service change resets the selected displayed line once, releasing its old clinical children. */
export function replaceDisplayGroupService<R extends InvoiceDisplayRowLike>(
  rows: readonly R[], keys: readonly string[], patch: Partial<R>, mode: ToothScopeMode,
  context: InvoiceDisplayGroupingContext<R> = {},
): R[] {
  const members = compatibleKeys(rows, keys, context);
  const first = rows.find(row => members.has(row.key));
  if (!first) return [...rows];
  let result = [...rows];
  for (let index = result.length - 1; index >= 0; index--) {
    if (members.has(result[index].key) && result[index].key !== first.key) result = removeRowAt(result, index);
  }
  return replaceRowService(result, result.findIndex(row => row.key === first.key),
    { ...patch, displayGroupId: null, quantity: members.size > 1 ? "1" : first.quantity,
      ...(Object.hasOwn(first, "planItemId") ? { planItemId: null } : {}) } as Partial<R>, mode);
}

/** Explicitly separate price/doctor presentation without changing clinical membership. */
export function splitDisplayGroupRow<R extends InvoiceDisplayRowLike>(rows: readonly R[], key: string): R[] {
  return rows.map(row => row.key === key ? { ...row, displayGroupId: null } : row);
}

function clearNewToothLink<R extends InvoiceDisplayRowLike>(row: R): R {
  return { ...row, caseId: "", ...(Object.hasOwn(row, "planItemId") ? { planItemId: null } : {}) };
}

/**
 * Batch tooth editing is only a projection over the existing clinical selector.
 * RCT children retain independent case identities and never gain episodeTeeth.
 * Bridge subgroup edits update the true whole episode while retaining outside
 * children and their individual prices, doctors, linkage and display identities.
 */
export function applyGroupedToothSelection<R extends InvoiceDisplayRowLike>(
  rows: readonly R[], index: number, mode: ToothScopeMode, selection: ToothSelection, makeKey: () => string,
  context: InvoiceDisplayGroupingContext<R> = {},
): R[] {
  const row = rows[index];
  if (!row) return [...rows];
  if (mode !== "per_tooth_episode" && mode !== "multi_tooth_episode") {
    return applyToothSelection(rows, index, mode, selection, makeKey).map(one => one.key === row.key ? { ...one, displayGroupId: null } : one);
  }
  const teeth = sortedTeeth(selection.teeth);
  if (teeth.some(tooth => !isValidTooth(tooth))) return [...rows];
  const group = buildInvoiceDisplayGroups(rows, context).find(one => one.indices.includes(index));
  if (!group) return [...rows];
  const requested = context.memberKeys ? new Set(context.memberKeys) : new Set(group.keys);
  const members = group.indices.filter(at => requested.has(rows[at].key)).map(at => rows[at]);
  if (!members.some(one => one.key === row.key)) return [...rows];
  const memberKeys = new Set(members.map(one => one.key));
  // Do not steal a tooth from an explicitly split or otherwise incompatible line.
  if (rows.some(one => !memberKeys.has(one.key) && one.serviceId === row.serviceId
    && one.toothCode !== null && teeth.includes(one.toothCode))) return [...rows];
  const displayGroupId = teeth.length > 1 ? row.displayGroupId ?? makeKey() : null;
  const desired = new Set(teeth);

  if (mode === "per_tooth_episode") {
    let working = [...rows];
    for (let at = working.length - 1; at >= 0; at--) {
      if (memberKeys.has(working[at].key) && working[at].key !== row.key) working = removeRowAt(working, at);
    }
    const at = working.findIndex(one => one.key === row.key);
    const result = applyToothSelection(working, at, mode, selection, makeKey);
    const retainedKeys = new Set(members.filter(one => one.toothCode !== null && desired.has(one.toothCode)).map(one => one.key));
    const usedKeys = new Set<string>();
    const replacements = result.slice(at, at + Math.max(1, teeth.length)).map(generated => {
      const existing = members.find(one => one.toothCode !== null && one.toothCode === generated.toothCode);
      let key = existing?.key ?? (!retainedKeys.has(row.key) && !usedKeys.has(row.key) ? row.key : makeKey());
      if (usedKeys.has(key)) key = makeKey();
      usedKeys.add(key);
      return {
        ...(existing ?? clearNewToothLink(generated)), key, quantity: "1", displayGroupId,
        toothCode: generated.toothCode, surfaces: "", scope: null, episodeTeeth: null, groupId: null,
      } as R;
    });
    return [...result.slice(0, at), ...replacements, ...result.slice(at + replacements.length)];
  }

  const clinical = row.groupId ? rows.filter(one => one.groupId === row.groupId) : [row];
  if (members.some(one => !clinical.includes(one))) return [...rows];
  const outside = clinical.filter(one => !memberKeys.has(one.key));
  const wholeTeeth = sortedTeeth([...teeth, ...outside.flatMap(one => one.toothCode === null ? [] : [one.toothCode])]);
  const result = applyToothSelection(rows, index, mode, { ...selection, teeth: wholeTeeth }, makeKey);
  const at = rows.findIndex(one => clinical.includes(one));
  const retainedKeys = new Set(clinical.filter(one => one.toothCode !== null && wholeTeeth.includes(one.toothCode)).map(one => one.key));
  const usedKeys = new Set<string>();
  const replacements = result.slice(at, at + Math.max(1, wholeTeeth.length)).map(generated => {
    const existing = clinical.find(one => one.toothCode !== null && one.toothCode === generated.toothCode);
    let key = existing?.key ?? (!retainedKeys.has(row.key) && !usedKeys.has(row.key) ? row.key : makeKey());
    if (usedKeys.has(key)) key = makeKey();
    usedKeys.add(key);
    const selected = generated.toothCode === null || desired.has(generated.toothCode);
    return {
      ...(existing ?? clearNewToothLink(generated)), key,
      toothCode: generated.toothCode, surfaces: generated.surfaces, scope: generated.scope,
      episodeTeeth: generated.episodeTeeth, groupId: generated.groupId,
      quantity: selected ? "1" : existing?.quantity ?? generated.quantity,
      displayGroupId: selected ? displayGroupId : existing?.displayGroupId,
    } as R;
  });
  return [...result.slice(0, at), ...replacements, ...result.slice(at + replacements.length)];
}
