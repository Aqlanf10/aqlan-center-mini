import { describe, expect, it, vi } from "vitest";
import { createSendIntent, freezeOccasionSnapshot, claimRecipient, evaluateOccasionRecipient, queuedRecipient,
  applyDispatchOutcome, type CandidateContact } from "../lib/occasion-campaign-core";
import { DEFAULT_CONFIG } from "../lib/messaging-channels";
import { verifyOccasionTemplate, sendOccasionTemplate, type OccasionProviderChannel, type OccasionSendGate } from "../lib/whatsapp-occasion-provider";
import { runOccasionCampaignBatch } from "../lib/occasion-campaign-runner";
import { createOccasionCampaignStore, type CampaignStoreDeps, type CampaignTransaction } from "../lib/occasion-campaign-store";
import type { CampaignBatchLease, CampaignClaim } from "../lib/occasion-campaign-runner";

const NOW = 1_800_000_000_000;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function fixture() {
  const channel: OccasionProviderChannel = { enabled: true, revision: "channel-1", secret: "synthetic-only-token",
    config: { ...DEFAULT_CONFIG.whatsapp, phoneNumberId: "12345678", businessAccountId: "87654321" } };
  const verified = await verifyOccasionTemplate({ channel, name: "greeting", language: "ar" }, {
    nowMs: () => NOW,
    fetchImpl: vi.fn(async (url: RequestInfo | URL) => String(url).includes("/phone_numbers")
      ? json({ data: [{ id: "12345678" }] }) : json({ data: [{ id: "template-1", name: "greeting", language: "ar",
        category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "كل عام وأنتم بخير." }] }] })) as unknown as typeof fetch,
  });
  if (!verified.ok) throw new Error("bad_synthetic_template");
  const gate: OccasionSendGate = { featureEnabled: true, channel, template: verified.template,
    approvedContentDigest: verified.template.contentDigest, reviewedGenericOccasion: true };
  const contact: CandidateContact = { patientId: 1, phone: "+967770000001", localCountry: null,
    contactRevision: "revision-1", identity: "unique", suppression: "clear",
    permission: { eventId: "grant-1", patientId: 1, channel: "whatsapp", purpose: "occasion", endpoint: "967770000001",
      contactRevision: "revision-1", decision: "granted", evidenceId: "evidence-1" } };
  const eligible = evaluateOccasionRecipient(contact, "whatsapp");
  if (!eligible.eligible) throw new Error("bad_synthetic_contact");
  const snapshot = freezeOccasionSnapshot({ templateId: gate.template.id, revision: gate.template.contentDigest,
    channel: "whatsapp", language: "ar", body: gate.template.renderedText, providerTemplateName: "greeting" }, [eligible.recipient]);
  const intent = createSendIntent({ campaignId: "campaign-1", draftRevision: 1, idempotencyKey: "send_request_000001", snapshot });
  const binding = { provider: "meta", scopeDigest: gate.template.scopeDigest, phoneNumberId: "12345678",
    businessAccountId: "87654321", channelRevision: "channel-1" };
  const campaign: Record<string, unknown> = { id: "campaign-1", state: "running", draft_revision: "1", draft_template: snapshot.template,
    preview_intent_canonical: intent.canonicalSnapshot, preview_revision: "1", authorization_id: "approval-1",
    authorized_intent_canonical: intent.canonicalSnapshot, approved_template: { ...gate.template, verifiedAtMs: NOW - 30_000 },
    approved_content_digest: gate.approvedContentDigest, provider_binding: binding, reviewed_generic_occasion: true,
    cancel_requested: false, lease_id: "lease-1", lease_generation: "1", lease_live: true, last_reason: null };
  const recipient: Record<string, unknown> = { id: "1", campaign_id: "campaign-1", patient_id: 1, endpoint: "967770000001",
    snapshot: eligible.recipient, state: "queued", current_attempt_id: null, provider_message_id: null, retryable: false };
  const attempt: Record<string, unknown> = { id: "attempt-1", recipient_id: "1", campaign_id: "campaign-1",
    authorization_id: "approval-1", lease_id: "lease-1", result_state: "claimed", provider_message_id: null, retryable: false,
    receipt_evidence: [],
    provider_scope_digest: gate.template.scopeDigest, sender_phone_number_id: "12345678" };
  const lease: CampaignBatchLease = { campaignId: "campaign-1", authorizationId: "approval-1", leaseId: "lease-1", gate };
  const claim: CampaignClaim = { campaignId: "campaign-1", authorizationId: "approval-1", recipientId: 1,
    snapshot: eligible.recipient, currentContact: contact,
    state: claimRecipient(queuedRecipient(), { campaignActive: true, snapshot: eligible.recipient, currentContact: contact, attemptId: "attempt-1" }) };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let suppression = false;
  let unresolved = false;
  let priorEvidence = false;
  let rememberedRequest: Record<string, unknown> | null = null;
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (sql === "SHOW transaction_isolation") return { rows: [{ transaction_isolation: "read committed" }] };
    if (sql.includes("messaging:read-suppression")) return { rows: [{ stop_id: suppression ? "stop-1" : null, clear_id: null }] };
    if (sql.includes("FROM occasion_campaign_send_requests")) return { rows: rememberedRequest ? [rememberedRequest] : [] };
    if (/SELECT .*FROM occasion_campaigns|SELECT \*,/.test(sql) && sql.includes("FROM occasion_campaigns")) return { rows: [campaign] };
    if (sql.includes("SELECT id FROM occasion_campaign_recipients") || sql.includes("SELECT 1 FROM occasion_campaign_recipients")) return { rows: unresolved ? [{ id: "1" }] : [] };
    if (sql.includes("SELECT 1 FROM occasion_campaign_attempts")) return { rows: priorEvidence ? [{ id: "attempt-1" }] : [] };
    if (sql.includes("SELECT * FROM occasion_campaign_attempts")) return { rows: [attempt] };
    if (sql.includes("SELECT * FROM occasion_campaign_recipients")) return { rows: [recipient] };
    if (sql.includes("SELECT 1 FROM occasion_campaign_batches")) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
  const tx: CampaignTransaction = { query: query as unknown as CampaignTransaction["query"], release: vi.fn() };
  let sequence = 0;
  const deps: CampaignStoreDeps = { pool: { connect: vi.fn(async () => tx) }, actor: { username: "synthetic-admin", role: "admin" },
    nowMs: () => NOW, newId: () => `generated-${++sequence}`, authorizeAdminOn: vi.fn(async () => true),
    resolveContactOn: vi.fn(async () => contact), bindingStillEnabledOn: vi.fn(async () => true), auditOn: vi.fn(async () => undefined) };
  return { store: createOccasionCampaignStore(deps), deps, tx, calls, query, campaign, recipient, attempt, gate, snapshot, intent, lease, claim,
    suppress: () => { suppression = true; }, markUnresolved: () => { unresolved = true; },
    markPriorEvidence: () => { priorEvidence = true; }, remember: (value: Record<string, unknown>) => { rememberedRequest = value; } };
}

/** These are injected source-flow tests, NOT PostgreSQL concurrency/constraint evidence. */
describe("occasion store authorization and fencing contracts", () => {
  it("refuses an incompatible transaction and discards a client if rollback fails", async () => {
    const f = await fixture();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (sql === "SHOW transaction_isolation") return { rows: [{ transaction_isolation: "repeatable read" }] };
      if (sql === "ROLLBACK") throw new Error("rollback unavailable");
      return original(sql, values);
    });
    await expect(f.store.cancel("campaign-1")).rejects.toThrow("read_committed_required");
    expect(f.deps.authorizeAdminOn).not.toHaveBeenCalled();
    expect(f.tx.release).toHaveBeenCalledWith(true);
    expect(f.calls.some(call => call.sql.includes("UPDATE occasion_campaigns"))).toBe(false);
  });
  it("replays equivalent authorization without resolving contacts or inserting another queue", async () => {
    const f = await fixture();
    f.gate.featureEnabled = false;
    expect(await f.store.authorizeCampaign({ intent: f.intent, snapshot: f.snapshot, gate: f.gate }))
      .toEqual({ kind: "replay", authorizationId: "approval-1" });
    expect(f.deps.resolveContactOn).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.sql.includes("INSERT INTO occasion_campaign_recipients"))).toBe(false);
    expect(f.calls.some(call => call.sql.includes("INSERT INTO occasion_campaign_send_requests"))).toBe(true);
    expect(f.calls[0].sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
  });
  it("refuses a request key previously bound to another campaign", async () => {
    const f = await fixture();
    f.remember({ campaign_id: "other-campaign", draft_revision: 1, intent_sha256: "other", authorization_id: "other" });
    await expect(f.store.authorizeCampaign({ intent: f.intent, snapshot: f.snapshot, gate: f.gate })).rejects.toThrow("send_request_key_conflict");
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.calls.some(call => call.sql.startsWith("INSERT"))).toBe(false);
  });
  it("requires fresh current admin authority and exact preview for a new send", async () => {
    const f = await fixture();
    f.campaign.authorization_id = null;
    f.campaign.state = "draft";
    f.campaign.preview_intent_canonical = "changed-preview";
    await expect(f.store.authorizeCampaign({ intent: f.intent, snapshot: f.snapshot, gate: f.gate })).rejects.toThrow("preview_changed");
    f.deps.authorizeAdminOn = vi.fn(async () => false);
    await expect(f.store.cancel("campaign-1")).rejects.toThrow("admin_required");
  });
  it("does not convert an expired claimed attempt back to queued", async () => {
    const f = await fixture();
    f.campaign.lease_live = false; f.markUnresolved();
    expect(await f.store.acquireBatch({ campaignId: "campaign-1", requestId: "batch-2" }, f.gate)).toEqual({ kind: "blocked" });
    expect(f.calls.some(call => call.sql.includes("result_state='uncertain'"))).toBe(true);
    expect(f.calls.some(call => call.sql.includes("state='needs_attention'"))).toBe(true);
    expect(f.calls.some(call => call.sql.includes("INSERT INTO occasion_campaign_batches"))).toBe(false);
  });
  it("allows unchanged provider content with a freshly verified timestamp, and claims endpoint-before-recipient", async () => {
    const f = await fixture();
    const result = await f.store.claimNext(f.lease);
    expect(result).toMatchObject({ kind: "claimed", claim: { recipientId: 1, state: { attemptId: "generated-1", status: "claimed" } } });
    const lock = f.calls.findIndex(call => call.sql.includes("messaging:endpoint-lock"));
    const row = f.calls.findIndex(call => call.sql.includes("FROM occasion_campaign_recipients WHERE id=") && call.sql.includes("FOR UPDATE"));
    expect(lock).toBeGreaterThan(-1); expect(row).toBeGreaterThan(lock);
    expect(f.calls.some(call => call.sql.includes("INSERT INTO occasion_campaign_attempts"))).toBe(true);
    expect(f.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("blocks stale leases, fresh STOP and prior acceptance evidence before any new attempt", async () => {
    const stale = await fixture(); stale.campaign.lease_id = "new-owner-lease";
    await expect(stale.store.claimNext(stale.lease)).rejects.toThrow("stale_or_inactive_campaign_lease");
    const stopped = await fixture(); stopped.suppress();
    expect(await stopped.store.claimNext(stopped.lease)).toEqual({ kind: "skipped" });
    expect(stopped.calls.some(call => call.sql.includes("INSERT INTO occasion_campaign_attempts"))).toBe(false);
    const accepted = await fixture(); accepted.markPriorEvidence();
    await expect(accepted.store.claimNext(accepted.lease)).rejects.toThrow("prior_dispatch_evidence");
  });
});

describe("provider evidence persistence and cancellation", () => {
  it("composes known 429 rejection, pause/release, then a separately authorized explicit retry", async () => {
    const f = await fixture();
    f.recipient.state = "claimed"; f.recipient.current_attempt_id = "attempt-1";
    // Minimal sequential fake projections only; this is not a SQL transaction emulator.
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values = []) => {
      const result = await original(sql, values);
      if (sql.includes("UPDATE occasion_campaign_attempts SET result_state=$2")) {
        f.attempt.result_state = values[1]; f.attempt.provider_message_id = values[2]; f.attempt.retryable = values[3];
      }
      if (sql.includes("UPDATE occasion_campaign_recipients SET state=$2")) {
        f.recipient.state = values[1]; f.recipient.provider_message_id = values[2]; f.recipient.retryable = values[3];
      }
      if (sql.includes("state='needs_attention', last_reason=$2")) {
        f.campaign.state = "needs_attention"; f.campaign.last_reason = values[1];
      }
      if (sql.includes("UPDATE occasion_campaigns SET lease_id=NULL")) {
        f.campaign.lease_id = null; f.campaign.lease_live = false;
      }
      return result;
    });
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { code: 130429 } }), {
      status: 429, headers: { "content-type": "application/json" },
    }));
    const report = await runOccasionCampaignBatch({ campaignId: "campaign-1", requestId: "batch-1" }, {
      nowMs: () => NOW, acquire: async () => ({ kind: "ready", lease: f.lease }),
      claimNext: async () => ({ kind: "claimed", claim: f.claim }),
      suppressBeforeDispatch: f.store.suppressBeforeDispatch,
      send: (lease, claim) => sendOccasionTemplate(lease.gate, claim.snapshot, {
        nowMs: () => NOW, fetchImpl: transport as typeof fetch, authorizeDispatch: async () => ({ allowed: true }),
      }),
      persistOutcome: f.store.persistOutcome, pause: f.store.pause, release: f.store.release,
    });
    expect(report).toMatchObject({ reason: "provider_stop", rejected: 1, accepted: 0, uncertain: 0 });
    expect(f.campaign).toMatchObject({ state: "needs_attention", last_reason: "provider_stop", lease_live: false });
    expect(f.recipient).toMatchObject({ state: "rejected", retryable: true, provider_message_id: null });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(f.calls.some(call => call.sql.includes("SET state='queued'"))).toBe(false);
    expect(await f.store.retryRejected("campaign-1", [1], f.gate)).toBe(1);
    expect(f.calls.some(call => call.sql.includes("SET state='queued', current_attempt_id=NULL"))).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1); // Requeue is separate from a later explicitly resumed batch.
  });
  it.each(["uncertain", "persistence_failure", "invalid_state", "unresolved_attempt", null, "unknown"])(
    "does not let explicit retry clear unrelated needs_attention reason %s", async reason => {
      const f = await fixture();
      f.campaign.state = "needs_attention"; f.campaign.last_reason = reason; f.campaign.lease_live = false;
      f.recipient.state = "rejected"; f.recipient.current_attempt_id = "attempt-1"; f.recipient.retryable = true;
      await expect(f.store.retryRejected("campaign-1", [1], f.gate)).rejects.toThrow("retry_blocked");
      expect(f.calls.some(call => call.sql.includes("SET state='queued'"))).toBe(false);
    },
  );
  it.each(["cancelled", "live_lease", "unresolved", "prior_evidence", "stop", "nonretryable", "binding"])(
    "keeps provider-stop explicit retry blocked by %s", async blocker => {
      const f = await fixture();
      f.campaign.state = "needs_attention"; f.campaign.last_reason = "provider_stop"; f.campaign.lease_live = false;
      f.recipient.state = "rejected"; f.recipient.current_attempt_id = "attempt-1"; f.recipient.retryable = true;
      if (blocker === "cancelled") f.campaign.cancel_requested = true;
      if (blocker === "live_lease") f.campaign.lease_live = true;
      if (blocker === "unresolved") f.markUnresolved();
      if (blocker === "prior_evidence") f.markPriorEvidence();
      if (blocker === "stop") f.suppress();
      if (blocker === "nonretryable") f.recipient.retryable = false;
      if (blocker === "binding") f.gate.channel.revision = "changed-channel";
      await expect(f.store.retryRejected("campaign-1", [1], f.gate)).rejects.toThrow();
      expect(f.calls.some(call => call.sql.includes("SET state='queued'"))).toBe(false);
    },
  );
  it("persists an exact late receipt after lease expiry/session revocation, without authorizing another send", async () => {
    const f = await fixture();
    f.campaign.lease_live = false;
    f.campaign.lease_id = "new-lease";
    f.recipient.state = "uncertain"; f.recipient.current_attempt_id = "attempt-1";
    f.attempt.result_state = "uncertain";
    f.deps.authorizeAdminOn = vi.fn(async () => false);
    const outcome = applyDispatchOutcome(f.claim.state, "attempt-1", { kind: "accepted", providerMessageId: "provider-receipt" });
    await f.store.persistOutcome(f.lease, f.claim, outcome);
    expect(f.deps.authorizeAdminOn).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.sql.includes("UPDATE occasion_campaign_attempts") && call.values.includes("provider-receipt"))).toBe(true);
    expect(f.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("will not replace an existing receipt or turn uncertainty into a rejection", async () => {
    const f = await fixture();
    f.recipient.state = "claimed"; f.recipient.current_attempt_id = "attempt-1";
    const rejected = applyDispatchOutcome(f.claim.state, "attempt-1", { kind: "not_accepted", retryable: true });
    f.attempt.provider_message_id = "existing-receipt"; f.attempt.result_state = "accepted";
    await expect(f.store.persistOutcome(f.lease, f.claim, rejected)).rejects.toThrow("provider_receipt_conflict");
    f.attempt.provider_message_id = null; f.attempt.result_state = "uncertain";
    await expect(f.store.persistOutcome(f.lease, f.claim, rejected)).rejects.toThrow("uncertain_cannot_reject");
  });
  it("retains unexpected receipt correlation when uncertainty is reconciled to acceptance", async () => {
    const f = await fixture();
    f.recipient.state = "uncertain"; f.recipient.current_attempt_id = "attempt-1";
    f.attempt.result_state = "uncertain"; f.attempt.receipt_evidence = ["unexpected-receipt"];
    const outcome = applyDispatchOutcome(f.claim.state, "attempt-1", { kind: "accepted", providerMessageId: "verified-receipt" });
    await f.store.persistOutcome(f.lease, f.claim, outcome);
    expect(f.calls.find(call => call.sql.includes("receipt_evidence=$5"))?.values[4]).toBe('["unexpected-receipt"]');
  });
  it("rolls back outcome persistence when its mandatory audit fails", async () => {
    const f = await fixture();
    f.recipient.state = "claimed"; f.recipient.current_attempt_id = "attempt-1";
    f.deps.auditOn = vi.fn(async () => { throw new Error("synthetic audit failure"); });
    const outcome = applyDispatchOutcome(f.claim.state, "attempt-1", { kind: "accepted", providerMessageId: "receipt" });
    await expect(f.store.persistOutcome(f.lease, f.claim, outcome)).rejects.toThrow("synthetic audit failure");
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("cancels only queued work and preserves attention for unresolved evidence", async () => {
    const f = await fixture();
    await f.store.cancel("campaign-1");
    const update = f.calls.find(call => call.sql.includes("UPDATE occasion_campaign_recipients"));
    expect(update?.sql).toContain("state='queued'");
    expect(update?.sql).not.toContain("provider_message_id=NULL");
    expect(f.calls.find(call => call.sql.includes("SET cancel_requested=TRUE"))?.sql).toContain("needs_attention");
  });
  it("release quarantines any leftover claimed attempt instead of falsely completing it", async () => {
    const f = await fixture();
    await f.store.release(f.lease);
    expect(f.calls.some(call => call.sql.includes("released_unresolved_claim"))).toBe(true);
    expect(f.calls.some(call => call.sql.includes("lease_id=NULL") && call.sql.includes("state IN ('claimed','uncertain')"))).toBe(true);
  });
});
