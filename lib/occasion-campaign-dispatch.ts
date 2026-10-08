/**
 * Server-internal, once-per-newly-claimed-attempt runner bridge. Never expose a
 * lease/claim/gate to clients or invoke this directly to resume an old claim.
 * The store's durable acquire/claim flow owns cross-request deduplication;
 * canDispatchOn is a live read, not a transferable one-use dispatch token.
 * No implicit transport or DB.
 */
import { immutableOccasionValue, sameOccasionValue, sendOccasionTemplate,
  type OccasionProviderAttempt, type ProviderDeps } from "./whatsapp-occasion-provider";
import type { CampaignBatchLease, CampaignClaim } from "./occasion-campaign-runner";
import type { CandidateContact } from "./occasion-campaign-core";
import { withServerOwnedOutboundGuard, type MessagingConnection, type QueryExecutor } from "./messaging-suppression";

export interface OccasionDispatchDeps extends ProviderDeps {
  connect(): Promise<MessagingConnection>;
  readContactOn(executor: QueryExecutor, claim: CampaignClaim): Promise<CandidateContact | null>;
  canDispatchOn(executor: QueryExecutor, lease: CampaignBatchLease, claim: CampaignClaim): Promise<boolean>;
}

export async function dispatchClaimedOccasion(inputLease: CampaignBatchLease, inputClaim: CampaignClaim,
  deps: OccasionDispatchDeps): Promise<OccasionProviderAttempt> {
  const { lease, claim } = immutableOccasionValue({ lease: inputLease, claim: inputClaim });
  const scopeResult = await withServerOwnedOutboundGuard<OccasionProviderAttempt>({ channel: "whatsapp",
    endpoint: claim.snapshot.endpoint, purpose: "occasion", occasionSnapshot: claim.snapshot }, {
    connect: deps.connect,
    readOrdinaryPolicyOn: async () => "deny", // This bridge only handles occasions; no ordinary-purpose fallback.
    readOccasionContactOn: executor => deps.readContactOn(executor, claim),
    dispatch: scope => sendOccasionTemplate(lease.gate, claim.snapshot, {
      fetchImpl: deps.fetchImpl, nowMs: deps.nowMs,
      authorizeDispatch: async binding => {
        if (!sameOccasionValue(binding.recipient, claim.snapshot) || binding.scopeDigest !== lease.gate.template.scopeDigest
          || binding.channelRevision !== lease.gate.channel.revision || binding.approvedContentDigest !== lease.gate.approvedContentDigest) {
          return { allowed: false, reason: "binding_changed" };
        }
        if (await scope.authorize() !== true) return { allowed: false, reason: "recipient_not_authorized" };
        if (await deps.canDispatchOn(scope.executor, lease, claim) !== true) return { allowed: false, reason: "binding_changed" };
        return { allowed: true };
      },
    }),
  });
  if (scopeResult.kind === "dispatched") return scopeResult.cleanupFailed
    ? { ...scopeResult.observedOutcome, stopCampaign: true } : scopeResult.observedOutcome;
  if (scopeResult.kind === "blocked") return { outcome: { kind: "not_accepted", retryable: false },
    reason: "recipient_not_authorized", stopCampaign: scopeResult.cleanupFailed };
  if (scopeResult.kind === "not_dispatched") return { outcome: { kind: "not_accepted", retryable: false },
    reason: "dispatch_authorization_unverified", stopCampaign: true };
  // A post-network transaction/cleanup failure never erases an observed acceptance receipt.
  // Persist this returned evidence against the already durable original attempt in a separate transaction.
  if (scopeResult.observedOutcome !== undefined) return { ...scopeResult.observedOutcome, stopCampaign: true };
  return { outcome: { kind: "unknown" }, reason: "ambiguous_response", stopCampaign: true };
}
