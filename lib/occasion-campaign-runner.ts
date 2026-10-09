/** Bounded admin-session worker; durable DB state is authoritative, never this function's memory. */
import { applyDispatchOutcome, assertRecipientState, recheckOccasionRecipient,
  type CandidateContact, type RecipientSnapshot, type RecipientState } from "./occasion-campaign-core";
import { immutableOccasionValue, sameOccasionValue, occasionSendReadiness, type OccasionProviderAttempt, type OccasionSendGate } from "./whatsapp-occasion-provider";

export const OCCASION_BATCH_LIMIT = 5;
export const OCCASION_BATCH_BUDGET_MS = 20_000;

export interface CampaignBatchLease {
  campaignId: string;
  authorizationId: string;
  leaseId: string;
  gate: OccasionSendGate;
}
export interface CampaignClaim {
  campaignId: string;
  authorizationId: string;
  recipientId: number;
  snapshot: Readonly<RecipientSnapshot>;
  currentContact: CandidateContact;
  state: Readonly<RecipientState>;
}
export type ClaimResult = { kind: "empty" } | { kind: "paused" } | { kind: "skipped" }
  | { kind: "claimed"; claim: CampaignClaim };
export interface CampaignBatchDeps {
  nowMs(): number;
  /**
   * Must verify admin/session, authorized immutable campaign, exact request replay,
   * absence of unresolved prior attempts and feature/provider readiness.
   * Acquire an exclusive short DB lease, never a process-only mutex.
   */
  acquire(input: { campaignId: string; requestId: string }): Promise<
    { kind: "ready"; lease: CampaignBatchLease } | { kind: "busy" | "blocked" | "replay" }>;
  /**
   * One recipient only. In a transaction recheck cancellation, current contact,
   * endpoint/channel suppression and occasion consent, then persist claim+attempt.
   * Both history and row must prove no acceptance receipt before claiming.
   */
  claimNext(lease: CampaignBatchLease): Promise<ClaimResult>;
  /** Only for a claim this invocation can prove has not reached the provider call. */
  suppressBeforeDispatch(lease: CampaignBatchLease, claim: CampaignClaim): Promise<void>;
  /** Production closure rechecks current enabled/config binding and shared STOP immediately before I/O. */
  send(lease: CampaignBatchLease, claim: CampaignClaim): Promise<OccasionProviderAttempt>;
  /** Atomically persist exact attempt outcome, receipt, audit and callback-inbox reconciliation. */
  persistOutcome(lease: CampaignBatchLease, claim: CampaignClaim, outcome: Readonly<RecipientState>,
    unverifiedReceiptEvidence: readonly string[]): Promise<void>;
  /** Pauses the campaign on uncertainty, global rejection, or persistence problems, without requeue. */
  pause(lease: CampaignBatchLease, reason: "uncertain" | "provider_stop" | "persistence_failure" | "invalid_state"): Promise<void>;
  release(lease: CampaignBatchLease): Promise<void>;
}
export interface CampaignBatchReport {
  reason: "busy" | "blocked" | "replay" | "paused" | "no_unclaimed_work" | "batch_limit" | "budget"
    | "uncertain" | "provider_stop" | "persistence_failure" | "invalid_state";
  /** Counts reflect outcomes whose persistence call was confirmed; never delivery counts. */
  accepted: number;
  rejected: number;
  uncertain: number;
  skipped: number;
  unconfirmedPersistence: number;
  leaseReleaseFailed: boolean;
}

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && value === value.trim();

export async function runOccasionCampaignBatch(input: {
  campaignId: string; requestId: string;
}, deps: CampaignBatchDeps): Promise<CampaignBatchReport> {
  if (!id(input.campaignId) || !id(input.requestId)) throw new Error("invalid_batch_request");
  const report: CampaignBatchReport = {
    reason: "batch_limit", accepted: 0, rejected: 0, uncertain: 0, skipped: 0,
    unconfirmedPersistence: 0, leaseReleaseFailed: false,
  };
  const request = immutableOccasionValue(input);
  const acquired = await deps.acquire(request);
  if (acquired === null || typeof acquired !== "object") throw new Error("invalid_batch_acquisition");
  if (acquired.kind !== "ready") {
    if (!["busy", "blocked", "replay"].includes(acquired.kind)) throw new Error("invalid_batch_acquisition");
    return { ...report, reason: acquired.kind };
  }
  const originalLease = acquired.lease;
  const lease = immutableOccasionValue(originalLease);
  // Do not pause/release an unrelated campaign returned by a corrupt acquisition mapper.
  if (!lease || lease.campaignId !== request.campaignId || !id(lease.leaseId) || !id(lease.authorizationId)) {
    throw new Error("invalid_batch_lease");
  }
  const startedAt = deps.nowMs();
  const seenRecipients = new Set<number>();
  const seenEndpoints = new Set<string>();
  const seenAttempts = new Set<string>();
  const pause = async (reason: "uncertain" | "provider_stop" | "persistence_failure" | "invalid_state") => {
    report.reason = reason;
    try { await deps.pause(lease, reason); }
    catch { report.reason = "persistence_failure"; report.unconfirmedPersistence += 1; }
  };
  try {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      await pause("invalid_state");
    } else if (!occasionSendReadiness(lease.gate, startedAt).ok) {
      report.reason = "blocked";
    } else {
      for (let index = 0; index < OCCASION_BATCH_LIMIT; index += 1) {
        if (!sameOccasionValue(originalLease, lease)) { await pause("invalid_state"); break; }
        const now = deps.nowMs();
        if (!Number.isSafeInteger(now) || now < startedAt) { await pause("invalid_state"); break; }
        if (now - startedAt >= OCCASION_BATCH_BUDGET_MS) { report.reason = "budget"; break; }
        let next: ClaimResult;
        try { next = await deps.claimNext(lease); }
        catch { await pause("persistence_failure"); break; }
        if (!sameOccasionValue(originalLease, lease)) { await pause("invalid_state"); break; }
        if (next === null || typeof next !== "object") { await pause("invalid_state"); break; }
        if (next.kind === "empty") { report.reason = "no_unclaimed_work"; break; }
        if (next.kind === "paused") { report.reason = "paused"; break; }
        if (next.kind === "skipped") { report.skipped += 1; continue; }
        if (next.kind !== "claimed") { await pause("invalid_state"); break; }
        const originalClaim = next.claim;
        let claim: CampaignClaim;
        try {
          claim = immutableOccasionValue(originalClaim);
          assertRecipientState(claim.state);
          if (claim.state.status !== "claimed" || claim.campaignId !== lease.campaignId
            || claim.authorizationId !== lease.authorizationId || claim.snapshot.channel !== "whatsapp"
            || !Number.isSafeInteger(claim.recipientId) || claim.recipientId <= 0) throw new Error("invalid_claim");
        } catch { await pause("invalid_state"); break; }
        if (seenRecipients.has(claim.recipientId) || seenEndpoints.has(claim.snapshot.endpoint) || seenAttempts.has(claim.state.attemptId!)) {
          await pause("invalid_state"); break;
        }
        seenRecipients.add(claim.recipientId);
        seenEndpoints.add(claim.snapshot.endpoint);
        seenAttempts.add(claim.state.attemptId!);
        let stillEligible: boolean;
        try { stillEligible = recheckOccasionRecipient(claim.snapshot, claim.currentContact).eligible; }
        catch { await pause("invalid_state"); break; }
        if (!stillEligible) {
          try { await deps.suppressBeforeDispatch(lease, claim); report.skipped += 1; }
          catch { await pause("persistence_failure"); break; }
          continue;
        }
        let observation: OccasionProviderAttempt;
        try { observation = await deps.send(lease, claim); }
        catch { observation = { outcome: { kind: "unknown" }, reason: "ambiguous_response", stopCampaign: true }; }
        let outcome: Readonly<RecipientState>;
        try { outcome = applyDispatchOutcome(claim.state, claim.state.attemptId!, observation?.outcome); }
        catch { await pause("invalid_state"); break; }
        const rawEvidence = observation?.receiptEvidence;
        const receiptEvidence = Array.isArray(rawEvidence)
          ? [...new Set(rawEvidence.filter(value => id(value) && /^[A-Za-z0-9:+._=/-]+$/.test(value)))].slice(0, 2) : [];
        const shouldStop = observation?.stopCampaign !== false;
        try { await deps.persistOutcome(lease, claim, outcome, Object.freeze(receiptEvidence)); }
        catch {
          // A DB error cannot prove a send did not happen or that COMMIT did not succeed.
          report.unconfirmedPersistence += 1;
          await pause("persistence_failure");
          break;
        }
        if (outcome.status === "accepted") report.accepted += 1;
        else if (outcome.status === "rejected") report.rejected += 1;
        else if (outcome.status === "uncertain") { report.uncertain += 1; await pause("uncertain"); break; }
        else { await pause("invalid_state"); break; }
        if (!sameOccasionValue(originalLease, lease) || !sameOccasionValue(originalClaim, claim)) { await pause("invalid_state"); break; }
        if (shouldStop) { await pause("provider_stop"); break; }
      }
    }
  } finally {
    try { await deps.release(lease); }
    catch { report.leaseReleaseFailed = true; report.reason = "persistence_failure"; }
  }
  return report;
}
