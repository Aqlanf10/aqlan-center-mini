import { isCurrency, type Currency } from "./money";
import type { LegacyVoidRefusal } from "./legacy-treatment";

/** These are two explicit operations; administrator status never silently selects the exception. */
export type LegacyVoidMode = "ordinary" | "manager_authorized";
export const LEGACY_VOID_PREVIEW_VERSION = 1;

export interface LegacyVoidFinancialFacts {
  patientId: number;
  agreementId: number;
  currency: Currency;
  status: "live" | "void";
  openingPrincipalBeforeMinor: number;
  removedPrincipalMinor: number;
  netCollectionsMinor: number;
  /** False for invalid currency conversion, unsafe amounts or unowned/changed opening principal. */
  financialEvidenceValid: boolean;
  periodLocked: boolean;
}

export interface LegacyVoidImpact {
  version: 1;
  mode: LegacyVoidMode;
  patientId: number;
  agreementId: number;
  currency: Currency;
  openingPrincipalBeforeMinor: number;
  removedPrincipalMinor: number;
  openingPrincipalAfterMinor: number;
  netCollectionsMinor: number;
  remainingDueBeforeMinor: number;
  remainingDueAfterMinor: number;
  ordinaryAllowed: boolean;
  managerAuthorizedAllowed: boolean;
  canVoid: boolean;
  refusal: LegacyVoidRefusal | null;
  financialReviewRequired: true;
}

export interface LegacyVoidPreview extends LegacyVoidImpact {
  /** Opaque optimistic concurrency fingerprint, scoped to actor, operation and current financial evidence. */
  previewToken: string;
}

export type LegacyVoidRequest = {
  reason: string;
  mode: LegacyVoidMode;
  previewToken?: string;
};

const validAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is number => validAmount(value) && value > 0;
export const isLegacyVoidMode = (value: unknown): value is LegacyVoidMode => value === "ordinary" || value === "manager_authorized";
const validToken = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);

/** No receipt is assigned to an agreement. Every amount remains in this patient's opening-currency bucket. */
export function previewLegacyVoid(facts: LegacyVoidFinancialFacts, mode: LegacyVoidMode): LegacyVoidImpact {
  const amountsValid = [facts.openingPrincipalBeforeMinor, facts.removedPrincipalMinor, facts.netCollectionsMinor].every(validAmount);
  const financialValid = facts.financialEvidenceValid && amountsValid
    && facts.openingPrincipalBeforeMinor >= facts.removedPrincipalMinor;
  const after = facts.openingPrincipalBeforeMinor - facts.removedPrincipalMinor;
  const commonRefusal: LegacyVoidRefusal | null = facts.status !== "live" ? "already_void"
    : !financialValid ? "opening_changed" : facts.periodLocked ? "period_locked" : null;
  // The ordinary guard is unconditional, including fully historically paid agreements with no own opening effect.
  const ordinaryRefusal = commonRefusal ?? (facts.netCollectionsMinor > 0 ? "opening_collected" : null);
  const managerRefusal = commonRefusal ?? (after < facts.netCollectionsMinor ? "opening_settled" : null);
  const refusal = mode === "ordinary" ? ordinaryRefusal : managerRefusal;
  return {
    version: LEGACY_VOID_PREVIEW_VERSION, mode, patientId: facts.patientId, agreementId: facts.agreementId, currency: facts.currency,
    openingPrincipalBeforeMinor: facts.openingPrincipalBeforeMinor, removedPrincipalMinor: facts.removedPrincipalMinor,
    openingPrincipalAfterMinor: after, netCollectionsMinor: facts.netCollectionsMinor,
    remainingDueBeforeMinor: Math.max(0, facts.openingPrincipalBeforeMinor - facts.netCollectionsMinor),
    remainingDueAfterMinor: Math.max(0, after - facts.netCollectionsMinor),
    ordinaryAllowed: ordinaryRefusal === null, managerAuthorizedAllowed: managerRefusal === null,
    canVoid: refusal === null, refusal, financialReviewRequired: true,
  };
}

export function parseLegacyVoidRequest(value: unknown):
  | { ok: true; value: LegacyVoidRequest }
  | { ok: false; reason: LegacyVoidRefusal } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "bad_void_request" };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["reason", "mode", "previewToken"].includes(key))) return { ok: false, reason: "bad_void_request" };
  const mode = body.mode === undefined ? "ordinary" : body.mode;
  if (!isLegacyVoidMode(mode)) return { ok: false, reason: "bad_void_request" };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300) return { ok: false, reason: "bad_reason" };
  if (body.previewToken !== undefined && !validToken(body.previewToken)) return { ok: false, reason: "preview_required" };
  if (mode === "manager_authorized" && !validToken(body.previewToken)) return { ok: false, reason: "preview_required" };
  return { ok: true, value: { reason, mode, ...(body.previewToken === undefined ? {} : { previewToken: body.previewToken as string }) } };
}

/** Defensive UI/API boundary: no coercion, wrong-patient preview, inconsistent arithmetic or hidden approval flags. */
export function parseLegacyVoidPreview(value: unknown, expected: { patientId: number; agreementId: number; mode: LegacyVoidMode }): LegacyVoidPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || !isLegacyVoidMode(p.mode) || p.mode !== expected.mode
    || !validId(p.patientId) || p.patientId !== expected.patientId || !validId(p.agreementId) || p.agreementId !== expected.agreementId
    || !isCurrency(p.currency) || !validToken(p.previewToken) || p.financialReviewRequired !== true) return null;
  const amountKeys = ["openingPrincipalBeforeMinor", "removedPrincipalMinor", "openingPrincipalAfterMinor", "netCollectionsMinor",
    "remainingDueBeforeMinor", "remainingDueAfterMinor"] as const;
  if (!amountKeys.every((key) => validAmount(p[key]))) return null;
  const before = p.openingPrincipalBeforeMinor as number, removed = p.removedPrincipalMinor as number;
  const after = p.openingPrincipalAfterMinor as number, collections = p.netCollectionsMinor as number;
  if (after !== before - removed || p.remainingDueBeforeMinor !== Math.max(0, before - collections)
    || p.remainingDueAfterMinor !== Math.max(0, after - collections)) return null;
  if (![p.ordinaryAllowed, p.managerAuthorizedAllowed, p.canVoid].every((flag) => typeof flag === "boolean")) return null;
  const refusals: readonly LegacyVoidRefusal[] = ["already_void", "opening_changed", "period_locked", "opening_collected", "opening_settled"];
  if (p.refusal !== null && !refusals.includes(p.refusal as LegacyVoidRefusal)) return null;
  if (p.canVoid !== (p.refusal === null) || p.canVoid !== (p.mode === "ordinary" ? p.ordinaryAllowed : p.managerAuthorizedAllowed)) return null;
  if (p.ordinaryAllowed !== (p.managerAuthorizedAllowed && collections === 0)) return null;
  if (["already_void", "opening_changed", "period_locked"].includes(p.refusal as string)
    && (p.ordinaryAllowed || p.managerAuthorizedAllowed)) return null;
  if (p.managerAuthorizedAllowed && after < collections) return null;
  if (p.refusal === "opening_collected" && (p.mode !== "ordinary" || collections <= 0)) return null;
  if (p.refusal === "opening_settled" && (p.mode !== "manager_authorized" || after >= collections)) return null;
  return p as unknown as LegacyVoidPreview;
}
