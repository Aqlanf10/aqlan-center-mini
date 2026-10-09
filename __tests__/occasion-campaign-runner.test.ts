import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../lib/messaging-channels";
import { claimRecipient, evaluateOccasionRecipient, queuedRecipient, type CandidateContact, type RecipientState } from "../lib/occasion-campaign-core";
import { verifyOccasionTemplate, type OccasionProviderChannel } from "../lib/whatsapp-occasion-provider";
import { runOccasionCampaignBatch, OCCASION_BATCH_LIMIT, type CampaignBatchDeps, type CampaignBatchLease,
  type CampaignClaim, type ClaimResult } from "../lib/occasion-campaign-runner";

const NOW = 1_800_000_000_000;
const request = { campaignId: "campaign-1", requestId: "batch-request-1" };
function claim(patientId: number): CampaignClaim {
  const endpoint = `96777000000${patientId}`;
  const currentContact: CandidateContact = { patientId, phone: `+${endpoint}`, localCountry: null,
    contactRevision: "contact-v1", identity: "unique", suppression: "clear",
    permission: { eventId: `grant-${patientId}`, patientId, channel: "whatsapp", purpose: "occasion",
      endpoint, contactRevision: "contact-v1", decision: "granted", evidenceId: `evidence-${patientId}` } };
  const eligibility = evaluateOccasionRecipient(currentContact, "whatsapp");
  if (!eligibility.eligible) throw new Error("bad_fixture");
  return { campaignId: "campaign-1", authorizationId: "approval-1", recipientId: patientId,
    snapshot: eligibility.recipient, currentContact,
    state: claimRecipient(queuedRecipient(), { campaignActive: true, snapshot: eligibility.recipient,
      currentContact, attemptId: `attempt-${patientId}` }) };
}
async function fixture(count = 2) {
  const channel: OccasionProviderChannel = { enabled: true, revision: "channel-v1", secret: "synthetic-no-real-token",
    config: { ...DEFAULT_CONFIG.whatsapp, phoneNumberId: "12345678", businessAccountId: "87654321" } };
  const verification = await verifyOccasionTemplate({ channel, name: "greeting", language: "ar" }, {
    nowMs: () => NOW,
    fetchImpl: vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).includes("/phone_numbers")
      ? { data: [{ id: channel.config.phoneNumberId }] } : { data: [{ id: "template-1", name: "greeting", language: "ar",
      status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "كل عام وأنتم بخير." }] }] }))) as unknown as typeof fetch,
  });
  if (!verification.ok) throw new Error("bad_provider_fixture");
  const lease: CampaignBatchLease = { campaignId: "campaign-1", authorizationId: "approval-1", leaseId: "lease-1",
    gate: { featureEnabled: true, channel, template: verification.template,
      approvedContentDigest: verification.template.contentDigest, reviewedGenericOccasion: true } };
  const pending = Array.from({ length: count }, (_, index) => claim(index + 1));
  const events: string[] = [];
  const deps: CampaignBatchDeps = {
    nowMs: () => NOW,
    acquire: vi.fn(async () => ({ kind: "ready" as const, lease })),
    claimNext: vi.fn(async (): Promise<ClaimResult> => {
      const value = pending.shift();
      if (!value) return { kind: "empty" };
      events.push(`claim:${value.recipientId}`);
      return { kind: "claimed", claim: value };
    }),
    suppressBeforeDispatch: vi.fn(async (_lease, value) => { events.push(`suppress:${value.recipientId}`); }),
    send: vi.fn(async (_lease, value) => {
      events.push(`send:${value.recipientId}`);
      return { outcome: { kind: "accepted" as const, providerMessageId: `receipt-${value.recipientId}` }, reason: "accepted" as const, stopCampaign: false };
    }),
    persistOutcome: vi.fn(async (_lease, value) => { events.push(`persist:${value.recipientId}`); }),
    pause: vi.fn(async () => undefined),
    release: vi.fn(async () => { events.push("release"); }),
  };
  return { lease, deps, pending, events };
}

describe("bounded admin-session WhatsApp campaign worker", () => {
  it.each(["same_attempt", "same_recipient", "same_endpoint", "attempt_on_other_recipient"] as const)(
    "refuses a faulty store's repeated claim identity: %s", async mode => {
      const { deps } = await fixture();
      const first = claim(1);
      let duplicate = claim(1);
      if (mode === "same_recipient") duplicate = { ...duplicate, state: { ...duplicate.state, attemptId: "new-attempt" } as RecipientState };
      if (mode === "same_endpoint") duplicate = { ...duplicate, recipientId: 99,
        state: { ...duplicate.state, attemptId: "new-attempt" } as RecipientState };
      if (mode === "attempt_on_other_recipient") duplicate = { ...claim(2),
        state: { ...claim(2).state, attemptId: "attempt-1" } as RecipientState };
      const rows = [first, duplicate];
      deps.claimNext = vi.fn(async () => ({ kind: "claimed" as const, claim: rows.shift()! }));
      expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "invalid_state", accepted: 1 });
      expect(deps.send).toHaveBeenCalledTimes(1);
      expect(deps.persistOutcome).toHaveBeenCalledTimes(1);
      expect(deps.pause).toHaveBeenCalledWith(expect.anything(), "invalid_state");
    },
  );
  it("uses immutable claim/lease identities when an async dependency mutates its original objects", async () => {
    const { deps, lease, pending } = await fixture();
    const originalClaim = pending[0];
    deps.send = vi.fn(async (boundLease, boundClaim) => {
      expect(Object.isFrozen(boundLease)).toBe(true);
      expect(Object.isFrozen(boundLease.gate.channel.config)).toBe(true);
      expect(Object.isFrozen(boundClaim)).toBe(true);
      expect(Object.isFrozen(boundClaim.state)).toBe(true);
      expect(Object.isFrozen(boundClaim.snapshot)).toBe(true);
      originalClaim.recipientId = 99;
      originalClaim.state = { status: "claimed", attemptId: "wrong-attempt", providerMessageId: null, retryable: false };
      lease.authorizationId = "wrong-approval";
      return { outcome: { kind: "accepted" as const, providerMessageId: "original-attempt-receipt" }, reason: "accepted" as const, stopCampaign: false };
    });
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "invalid_state", accepted: 1 });
    expect(deps.persistOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-1", authorizationId: "approval-1" }),
      expect.objectContaining({ recipientId: 1, state: expect.objectContaining({ attemptId: "attempt-1" }) }),
      expect.objectContaining({ status: "accepted", attemptId: "attempt-1", providerMessageId: "original-attempt-receipt" }), [],
    );
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
  });
  it("rejects an intervening lease binding change while claiming before any send", async () => {
    const { deps, lease } = await fixture();
    deps.claimNext = vi.fn(async () => {
      lease.gate.approvedContentDigest = "changed-approval";
      return { kind: "claimed" as const, claim: claim(1) };
    });
    expect((await runOccasionCampaignBatch(request, deps)).reason).toBe("invalid_state");
    expect(deps.send).not.toHaveBeenCalled();
  });
  it("does not rebind an accepted receipt if the source claim changes during persistence", async () => {
    const { deps, pending } = await fixture();
    const originalClaim = pending[0];
    deps.persistOutcome = vi.fn(async (_lease, boundClaim, outcome) => {
      expect(boundClaim.recipientId).toBe(1);
      expect(outcome.attemptId).toBe("attempt-1");
      originalClaim.recipientId = 99;
      originalClaim.snapshot = claim(2).snapshot;
    });
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "invalid_state", accepted: 1 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
  });
  it("captures provider stop intent before an async persistence callback can change it", async () => {
    const { deps } = await fixture();
    const observation = { outcome: { kind: "not_accepted" as const, retryable: true }, reason: "rate_limited" as const, stopCampaign: true };
    deps.send = vi.fn(async () => observation);
    deps.persistOutcome = vi.fn(async () => { observation.stopCampaign = false; });
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "provider_stop", rejected: 1 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
  });
  it("does not mutate a different campaign when acquisition returns a corrupt lease", async () => {
    const { deps, lease } = await fixture();
    deps.acquire = vi.fn(async () => ({ kind: "ready" as const, lease: { ...lease, campaignId: "unrelated-campaign" } }));
    await expect(runOccasionCampaignBatch(request, deps)).rejects.toThrow("invalid_batch_lease");
    expect(deps.claimNext).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.pause).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });
  it("claims, sends and persists one recipient at a time; does not imply delivery", async () => {
    const { deps, events } = await fixture();
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "no_unclaimed_work", accepted: 2,
      rejected: 0, uncertain: 0, unconfirmedPersistence: 0 });
    expect(events).toEqual(["claim:1", "send:1", "persist:1", "claim:2", "send:2", "persist:2", "release"]);
    expect(deps.release).toHaveBeenCalledTimes(1);
  });
  it.each(["busy", "blocked", "replay"] as const)("never claims or sends when acquisition says %s", async kind => {
    const { deps } = await fixture();
    deps.acquire = vi.fn(async () => ({ kind }));
    expect((await runOccasionCampaignBatch(request, deps)).reason).toBe(kind);
    expect(deps.claimNext).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });
  it("does not send through a default-off feature or a stale/broken provider gate", async () => {
    const { deps, lease } = await fixture();
    lease.gate.featureEnabled = false;
    expect((await runOccasionCampaignBatch(request, deps)).reason).toBe("blocked");
    expect(deps.claimNext).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledTimes(1);
  });
  it("caps each HTTP batch and leaves remaining queue work durable", async () => {
    const { deps, pending } = await fixture(OCCASION_BATCH_LIMIT + 1);
    const result = await runOccasionCampaignBatch(request, deps);
    expect(result).toMatchObject({ reason: "batch_limit", accepted: OCCASION_BATCH_LIMIT });
    expect(pending).toHaveLength(1);
    expect(deps.send).toHaveBeenCalledTimes(OCCASION_BATCH_LIMIT);
  });
  it("stops before claiming another recipient when the batch budget elapses", async () => {
    const { deps } = await fixture();
    let calls = 0;
    deps.nowMs = () => calls++ === 0 ? NOW : NOW + 20_000;
    expect((await runOccasionCampaignBatch(request, deps)).reason).toBe("budget");
    expect(deps.claimNext).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
  it("a cancellation between persisted attempts prevents the next claim/send", async () => {
    const { deps } = await fixture();
    let first = true;
    deps.claimNext = vi.fn(async () => {
      if (first) { first = false; return { kind: "claimed" as const, claim: claim(1) }; }
      return { kind: "paused" as const };
    });
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "paused", accepted: 1 });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it("does not send a newly suppressed claimed contact before any provider call", async () => {
    const { deps, pending } = await fixture(1);
    pending[0].currentContact.suppression = "suppressed";
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "no_unclaimed_work", skipped: 1 });
    expect(deps.suppressBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(deps.send).not.toHaveBeenCalled();
  });
  it("a transport exception becomes a persisted uncertain attempt and pauses later sends", async () => {
    const { deps } = await fixture();
    deps.send = vi.fn(async () => { throw new Error("synthetic timeout"); });
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "uncertain", uncertain: 1, accepted: 0 });
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
    expect(deps.pause).toHaveBeenCalledWith(expect.anything(), "uncertain");
    expect(deps.persistOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ status: "uncertain", retryable: false }), []);
  });
  it("does not call another recipient or invite resend after provider acceptance but uncertain DB persistence", async () => {
    const { deps } = await fixture();
    deps.persistOutcome = vi.fn(async () => { throw new Error("synthetic DB timeout after possible commit"); });
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "persistence_failure", accepted: 0,
      unconfirmedPersistence: 1 });
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.pause).toHaveBeenCalledWith(expect.anything(), "persistence_failure");
    expect(deps.release).toHaveBeenCalledTimes(1);
  });
  it("retains separate unverified receipt evidence for reconciliation without matching it as accepted", async () => {
    const { deps } = await fixture();
    deps.send = vi.fn(async () => ({ outcome: { kind: "unknown" as const }, reason: "ambiguous_response" as const,
      stopCampaign: true, receiptEvidence: ["unverified-receipt"] }));
    expect((await runOccasionCampaignBatch(request, deps)).reason).toBe("uncertain");
    expect(deps.persistOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ status: "uncertain", providerMessageId: null }), ["unverified-receipt"]);
  });
  it("fails closed on contradictory claimed receipt evidence or wrong campaign authorization", async () => {
    for (const corrupt of [
      { ...claim(1), state: { status: "claimed", attemptId: "attempt-1", providerMessageId: "already-accepted", retryable: false } as unknown as RecipientState },
      { ...claim(1), authorizationId: "wrong-approval" },
    ]) {
      const { deps } = await fixture();
      deps.claimNext = vi.fn(async () => ({ kind: "claimed" as const, claim: corrupt }));
      expect((await runOccasionCampaignBatch(request, deps)).reason).toBe("invalid_state");
      expect(deps.send).not.toHaveBeenCalled();
      expect(deps.persistOutcome).not.toHaveBeenCalled();
    }
  });
  it("stops on a provider-wide rejection but never retries inside the batch", async () => {
    const { deps } = await fixture();
    deps.send = vi.fn(async () => ({ outcome: { kind: "not_accepted" as const, retryable: true },
      reason: "rate_limited" as const, stopCampaign: true }));
    expect(await runOccasionCampaignBatch(request, deps)).toMatchObject({ reason: "provider_stop", rejected: 1 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
  });
  it("stops safely when persisted current-contact data is malformed", async () => {
    const { deps } = await fixture();
    deps.claimNext = vi.fn(async () => ({ kind: "claimed" as const, claim: { ...claim(1), currentContact: null as unknown as CandidateContact } }));
    expect((await runOccasionCampaignBatch(request, deps)).reason).toBe("invalid_state");
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.pause).toHaveBeenCalledWith(expect.anything(), "invalid_state");
  });
});
