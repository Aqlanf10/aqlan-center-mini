/**
 * Unpublished injected PostgreSQL store. No db.ts import, schema initialization or provider I/O.
 * All callers are server-side. No function in this file has been executed for this task.
 */
import { createHash } from "node:crypto";
import { assertRecipientState, createSendIntent, recheckOccasionRecipient, type CampaignSnapshot,
  retryRejectedRecipient, type CandidateContact, type RecipientSnapshot, type RecipientState, type SendIntent } from "./occasion-campaign-core";
import { immutableOccasionValue, occasionSendReadiness, sameOccasionValue, type OccasionSendGate } from "./whatsapp-occasion-provider";
import type { CampaignBatchLease, CampaignClaim, ClaimResult } from "./occasion-campaign-runner";
import { lockMessagingEndpoint, readEndpointSuppressionOn, type QueryExecutor } from "./messaging-suppression";

export interface CampaignTransaction extends QueryExecutor { release(discard?: boolean): void | Promise<void> }
export interface CampaignPool { connect(): Promise<CampaignTransaction> }
export interface CampaignStoreDeps {
  pool: CampaignPool;
  actor: { username: string; role: "admin" };
  nowMs(): number;
  newId(): string;
  /** Must query current active admin authority. A client/session snapshot alone is insufficient. */
  authorizeAdminOn(executor: QueryExecutor, username: string): Promise<boolean>;
  /** Complete authoritative full-phone identity, current revision, latest scoped permission and STOP. */
  resolveContactOn(executor: QueryExecutor, snapshot: Readonly<RecipientSnapshot>): Promise<CandidateContact | null>;
  /** Current default-off feature/channel/config state, without provider network I/O inside the transaction. */
  bindingStillEnabledOn(executor: QueryExecutor, gate: OccasionSendGate): Promise<boolean>;
  /** Required transactional audit writer; failure rolls the transaction back. No phones/body/credentials in details. */
  auditOn(executor: QueryExecutor, entry: { action: string; campaignId: string; actor: string; details: Record<string, unknown> }): Promise<void>;
}
type CampaignRow = Record<string, unknown> & {
  id: string; state: string; draft_revision: string | number; draft_template: unknown;
  preview_intent_canonical: string | null; preview_revision: string | number | null;
  authorization_id: string | null; authorized_intent_canonical: string | null; approved_template: unknown;
  approved_content_digest: string | null; provider_binding: unknown; reviewed_generic_occasion: boolean;
  cancel_requested: boolean; lease_id: string | null; lease_generation: string | number; lease_live: boolean;
};
type RecipientRow = Record<string, unknown> & {
  id: string | number; campaign_id: string; patient_id: number | null; endpoint: string; snapshot: RecipientSnapshot;
  state: RecipientState["status"]; current_attempt_id: string | null; provider_message_id: string | null; retryable: boolean;
};
type AttemptRow = Record<string, unknown> & {
  id: string; recipient_id: string | number; campaign_id: string; authorization_id: string; lease_id: string;
  result_state: "claimed" | "accepted" | "rejected" | "uncertain"; provider_message_id: string | null; retryable: boolean;
  receipt_evidence: unknown;
};

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const positiveInteger = (value: unknown): number => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) throw new Error("corrupt_store_integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("corrupt_store_integer");
  return number;
};

function recipientState(row: RecipientRow): Readonly<RecipientState> {
  const value = { status: row.state, attemptId: row.current_attempt_id, providerMessageId: row.provider_message_id, retryable: row.retryable };
  assertRecipientState(value);
  return immutableOccasionValue(value);
}
function publicBinding(gate: OccasionSendGate) {
  return { provider: gate.template.provider, scopeDigest: gate.template.scopeDigest,
    phoneNumberId: gate.channel.config.phoneNumberId,
    businessAccountId: gate.template.provider === "meta" ? gate.channel.config.businessAccountId ?? null : null,
    channelRevision: gate.channel.revision };
}
function stableTemplate(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_stored_template");
  const copy = { ...value } as Record<string, unknown>;
  delete copy.verifiedAtMs; // A fresh verification of unchanged content is required on a later batch.
  return copy;
}

export function createOccasionCampaignStore(deps: CampaignStoreDeps) {
  const actor = immutableOccasionValue(deps.actor);
  if (actor.role !== "admin" || !id(actor.username)) throw new Error("admin_required");
  const nextId = () => { const value = deps.newId(); if (!id(value)) throw new Error("invalid_generated_id"); return value; };
  const transact = async <T>(adminRequired: boolean, work: (tx: CampaignTransaction) => Promise<T>): Promise<T> => {
    const tx = await deps.pool.connect();
    let discard = false;
    try {
      await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const isolation = await tx.query("SHOW transaction_isolation");
      if (isolation.rows.length !== 1 || isolation.rows[0]?.transaction_isolation !== "read committed") throw new Error("read_committed_required");
      if (adminRequired && await deps.authorizeAdminOn(tx, actor.username) !== true) throw new Error("admin_required");
      const result = await work(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      try { await tx.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { await tx.release(discard); }
  };
  const campaignOn = async (tx: QueryExecutor, campaignId: string): Promise<CampaignRow> => {
    const result = await tx.query<CampaignRow>(`SELECT *, COALESCE(lease_expires_at > clock_timestamp(), FALSE) AS lease_live
      FROM occasion_campaigns WHERE id = $1 FOR UPDATE`, [campaignId]);
    if (result.rows.length !== 1) throw new Error("campaign_not_found");
    return result.rows[0];
  };
  const audit = (tx: QueryExecutor, action: string, campaignId: string, details: Record<string, unknown> = {}) =>
    deps.auditOn(tx, { action, campaignId, actor: actor.username, details });
  const requireLease = (row: CampaignRow, lease: CampaignBatchLease) => {
    if (row.id !== lease.campaignId || row.authorization_id !== lease.authorizationId || row.lease_id !== lease.leaseId
      || row.lease_live !== true || row.cancel_requested !== false || !["queued", "running"].includes(row.state)) {
      throw new Error("stale_or_inactive_campaign_lease");
    }
    if (row.approved_content_digest !== lease.gate.approvedContentDigest
      || !sameOccasionValue(stableTemplate(row.approved_template), stableTemplate(lease.gate.template))
      || !sameOccasionValue(row.provider_binding, publicBinding(lease.gate))) throw new Error("campaign_binding_changed");
  };
  const eligibleOn = async (tx: QueryExecutor, snapshot: Readonly<RecipientSnapshot>): Promise<CandidateContact | null> => {
    const suppression = await readEndpointSuppressionOn(tx, "whatsapp", snapshot.endpoint);
    if (suppression.status !== "clear") return null;
    const current = await deps.resolveContactOn(tx, snapshot);
    return current && recheckOccasionRecipient(snapshot, current).eligible ? current : null;
  };

  async function authorizeCampaign(input: {
    intent: Readonly<SendIntent>; snapshot: Readonly<CampaignSnapshot>; gate: OccasionSendGate;
  }): Promise<{ kind: "authorized" | "replay"; authorizationId: string }> {
    const approved = immutableOccasionValue(input);
    const rebuilt = createSendIntent({ campaignId: approved.intent.campaignId, draftRevision: approved.intent.draftRevision,
      idempotencyKey: approved.intent.idempotencyKey, snapshot: approved.snapshot });
    if (!sameOccasionValue(rebuilt, approved.intent) || approved.snapshot.channel !== "whatsapp") throw new Error("invalid_campaign_intent");
    return transact(true, async tx => {
      const row = await campaignOn(tx, approved.intent.campaignId);
      const requestHash = sha256(approved.intent.canonicalSnapshot);
      const priorRequest = await tx.query(`SELECT campaign_id,draft_revision,intent_sha256,authorization_id FROM occasion_campaign_send_requests
        WHERE actor=$1 AND request_key=$2 FOR UPDATE`, [actor.username, approved.intent.idempotencyKey]);
      const remembered = priorRequest.rows[0];
      if (remembered && (remembered.campaign_id !== row.id || Number(remembered.draft_revision) !== approved.intent.draftRevision
        || remembered.intent_sha256 !== requestHash || remembered.authorization_id !== row.authorization_id)) throw new Error("send_request_key_conflict");
      if (row.authorization_id !== null) {
        if (row.authorized_intent_canonical !== approved.intent.canonicalSnapshot
          || positiveInteger(row.draft_revision) !== approved.intent.draftRevision) throw new Error("send_intent_conflict");
        if (!remembered) await tx.query(`INSERT INTO occasion_campaign_send_requests(actor,request_key,campaign_id,draft_revision,intent_sha256,authorization_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [actor.username, approved.intent.idempotencyKey, row.id, approved.intent.draftRevision, requestHash, row.authorization_id]);
        return { kind: "replay", authorizationId: row.authorization_id };
      }
      if (row.state !== "draft" || row.cancel_requested !== false || positiveInteger(row.draft_revision) !== approved.intent.draftRevision
        || row.preview_revision === null || positiveInteger(row.preview_revision) !== approved.intent.draftRevision
        || row.preview_intent_canonical !== approved.intent.canonicalSnapshot
        || !sameOccasionValue(row.draft_template, approved.snapshot.template)) throw new Error("preview_changed");
      if (!occasionSendReadiness(approved.gate, deps.nowMs()).ok || await deps.bindingStillEnabledOn(tx, approved.gate) !== true) throw new Error("provider_not_ready");
      const template = approved.snapshot.template;
      if (template.templateId !== approved.gate.template.id || template.revision !== approved.gate.template.contentDigest
        || template.language !== approved.gate.template.language || template.body !== approved.gate.template.renderedText
        || template.providerTemplateName !== approved.gate.template.name) throw new Error("template_binding_changed");
      // Sorted endpoint lock order for a campaign authorization; STOP never acquires campaign rows.
      const recipients = [...approved.snapshot.recipients].sort((a, b) => a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0);
      for (const recipient of recipients) {
        await lockMessagingEndpoint(tx, "whatsapp", recipient.endpoint);
        if (!await eligibleOn(tx, recipient)) throw new Error("recipient_preview_changed");
      }
      const authorizationId = nextId();
      await tx.query(`UPDATE occasion_campaigns SET state='queued', authorization_id=$2, authorized_intent_canonical=$3,
        authorized_intent_sha256=$4, send_request_key=$5, approved_template=$6::jsonb, provider_binding=$7::jsonb,
        approved_content_digest=$8, reviewed_generic_occasion=TRUE, authorized_by=$9, authorized_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE id=$1`, [row.id, authorizationId, approved.intent.canonicalSnapshot, sha256(approved.intent.canonicalSnapshot),
        approved.intent.idempotencyKey, JSON.stringify(approved.gate.template), JSON.stringify(publicBinding(approved.gate)),
        approved.gate.approvedContentDigest, actor.username]);
      for (const recipient of recipients) await tx.query(`INSERT INTO occasion_campaign_recipients
        (campaign_id, patient_id, endpoint, snapshot, contact_revision, consent_event_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [row.id, recipient.patientId, recipient.endpoint, JSON.stringify(recipient), recipient.contactRevision, recipient.consentEventId]);
      await tx.query(`INSERT INTO occasion_campaign_send_requests(actor,request_key,campaign_id,draft_revision,intent_sha256,authorization_id)
        VALUES($1,$2,$3,$4,$5,$6)`, [actor.username, approved.intent.idempotencyKey, row.id, approved.intent.draftRevision, requestHash, authorizationId]);
      await audit(tx, "occasion_campaign.authorize", row.id, { authorizationId, recipients: recipients.length, intentHash: sha256(approved.intent.canonicalSnapshot) });
      return { kind: "authorized", authorizationId };
    });
  }

  async function acquireBatch(input: { campaignId: string; requestId: string }, serverGate: OccasionSendGate): Promise<
    { kind: "ready"; lease: CampaignBatchLease } | { kind: "busy" | "blocked" | "replay" }> {
    const requested = immutableOccasionValue({ ...input, gate: serverGate });
    if (!id(requested.campaignId) || !id(requested.requestId)) throw new Error("invalid_batch_request");
    return transact(true, async tx => {
      const row = await campaignOn(tx, requested.campaignId);
      const prior = await tx.query(`SELECT 1 FROM occasion_campaign_batches WHERE campaign_id=$1 AND request_key=$2`, [row.id, requested.requestId]);
      if (prior.rows.length > 0) return { kind: "replay" };
      if (row.authorization_id === null || row.cancel_requested !== false || !["queued", "running"].includes(row.state)) return { kind: "blocked" };
      if (row.lease_live === true) return { kind: "busy" };
      const unresolved = await tx.query(`SELECT id FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state IN ('claimed','uncertain') LIMIT 1`, [row.id]);
      if (unresolved.rows.length > 0) {
        await tx.query(`UPDATE occasion_campaign_attempts SET result_state='uncertain', retryable=FALSE, finished_at=clock_timestamp()
          WHERE campaign_id=$1 AND result_state='claimed'`, [row.id]);
        await tx.query(`UPDATE occasion_campaign_recipients SET state='uncertain', retryable=FALSE, last_reason='expired_claim', updated_at=clock_timestamp()
          WHERE campaign_id=$1 AND state='claimed'`, [row.id]);
        await tx.query(`UPDATE occasion_campaigns SET state='needs_attention', last_reason='unresolved_attempt', updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
        await audit(tx, "occasion_campaign.recovery_block", row.id);
        return { kind: "blocked" };
      }
      if (!occasionSendReadiness(requested.gate, deps.nowMs()).ok || await deps.bindingStillEnabledOn(tx, requested.gate) !== true
        || row.approved_content_digest !== requested.gate.approvedContentDigest
        || !sameOccasionValue(stableTemplate(row.approved_template), stableTemplate(requested.gate.template))
        || !sameOccasionValue(row.provider_binding, publicBinding(requested.gate))) return { kind: "blocked" };
      const generation = Number(row.lease_generation) + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("corrupt_lease_generation");
      const leaseId = nextId();
      await tx.query(`INSERT INTO occasion_campaign_batches(id,campaign_id,request_key,lease_id,generation,actor) VALUES($1,$2,$3,$4,$5,$6)`,
        [nextId(), row.id, requested.requestId, leaseId, generation, actor.username]);
      await tx.query(`UPDATE occasion_campaigns SET state='running', lease_id=$2, lease_generation=$3,
        lease_expires_at=clock_timestamp()+INTERVAL '60 seconds', updated_at=clock_timestamp() WHERE id=$1`, [row.id, leaseId, generation]);
      await audit(tx, "occasion_campaign.batch_start", row.id, { generation });
      return { kind: "ready", lease: immutableOccasionValue({ campaignId: row.id, authorizationId: row.authorization_id, leaseId, gate: requested.gate }) };
    });
  }

  async function claimNext(input: CampaignBatchLease): Promise<ClaimResult> {
    const lease = immutableOccasionValue(input);
    return transact(true, async tx => {
      const row = await campaignOn(tx, lease.campaignId);
      requireLease(row, lease);
      if (await deps.bindingStillEnabledOn(tx, lease.gate) !== true) return { kind: "paused" };
      const inFlight = await tx.query(`SELECT 1 FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state IN ('claimed','uncertain') LIMIT 1`, [row.id]);
      if (inFlight.rows.length > 0) return { kind: "paused" };
      // Campaign row serializes claims. Read candidate, then endpoint lock, THEN recipient row lock.
      const candidate = await tx.query<RecipientRow>(`SELECT * FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state='queued' ORDER BY id LIMIT 1`, [row.id]);
      if (candidate.rows.length === 0) return { kind: "empty" };
      await lockMessagingEndpoint(tx, "whatsapp", candidate.rows[0].endpoint);
      const locked = await tx.query<RecipientRow>(`SELECT * FROM occasion_campaign_recipients WHERE id=$1 AND campaign_id=$2 FOR UPDATE`, [candidate.rows[0].id, row.id]);
      if (locked.rows.length !== 1) throw new Error("recipient_not_found");
      const recipient = locked.rows[0];
      const state = recipientState(recipient);
      if (state.status !== "queued") return { kind: "skipped" };
      const snapshot = immutableOccasionValue(recipient.snapshot);
      const current = recipient.patient_id !== null ? await eligibleOn(tx, snapshot) : null;
      if (!current) {
        await tx.query(`UPDATE occasion_campaign_recipients SET state='suppressed', last_reason='eligibility_changed', updated_at=clock_timestamp() WHERE id=$1`, [recipient.id]);
        await audit(tx, "occasion_campaign.recipient_suppress", row.id, { recipientId: String(recipient.id) });
        return { kind: "skipped" };
      }
      const priorEvidence = await tx.query(`SELECT 1 FROM occasion_campaign_attempts WHERE recipient_id=$1
        AND (provider_message_id IS NOT NULL OR result_state IN ('accepted','uncertain','claimed')) LIMIT 1`, [recipient.id]);
      if (priorEvidence.rows.length > 0) throw new Error("prior_dispatch_evidence");
      const attemptId = nextId();
      await tx.query(`INSERT INTO occasion_campaign_attempts(id,campaign_id,recipient_id,authorization_id,lease_id,provider_scope_digest,sender_phone_number_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [attemptId, row.id, recipient.id, lease.authorizationId, lease.leaseId,
        lease.gate.template.scopeDigest, lease.gate.channel.config.phoneNumberId]);
      await tx.query(`UPDATE occasion_campaign_recipients SET state='claimed', current_attempt_id=$2, retryable=FALSE,
        last_reason=NULL, updated_at=clock_timestamp() WHERE id=$1`, [recipient.id, attemptId]);
      await audit(tx, "occasion_campaign.claim", row.id, { recipientId: String(recipient.id), attemptId });
      return { kind: "claimed", claim: immutableOccasionValue({ campaignId: row.id, authorizationId: lease.authorizationId,
        recipientId: positiveInteger(recipient.id), snapshot, currentContact: current,
        state: { status: "claimed", attemptId, providerMessageId: null, retryable: false } }) };
    });
  }

  async function persistOutcome(inputLease: CampaignBatchLease, inputClaim: CampaignClaim, inputOutcome: Readonly<RecipientState>, evidence: readonly string[] = []): Promise<void> {
    const { lease, claim, outcome, receipts } = immutableOccasionValue({ lease: inputLease, claim: inputClaim, outcome: inputOutcome, receipts: evidence });
    assertRecipientState(outcome);
    assertRecipientState(claim.state);
    if (claim.state.status !== "claimed") throw new Error("invalid_captured_claim");
    if (!["accepted", "rejected", "uncertain"].includes(outcome.status) || outcome.attemptId !== claim.state.attemptId
      || claim.campaignId !== lease.campaignId || claim.authorizationId !== lease.authorizationId) throw new Error("invalid_attempt_outcome");
    if (receipts.length > 2 || receipts.some(value => !id(value) || !/^[A-Za-z0-9:+._=/-]+$/.test(value))) throw new Error("invalid_receipt_evidence");
    // Recording already-observed provider evidence must survive session revocation or lease expiry.
    await transact(false, async tx => {
      const campaign = await campaignOn(tx, lease.campaignId);
      const attempts = await tx.query<AttemptRow>(`SELECT * FROM occasion_campaign_attempts WHERE id=$1 AND recipient_id=$2
        AND campaign_id=$3 AND authorization_id=$4 AND lease_id=$5 FOR UPDATE`,
      [outcome.attemptId, claim.recipientId, claim.campaignId, claim.authorizationId, lease.leaseId]);
      if (attempts.rows.length !== 1 || campaign.authorization_id !== claim.authorizationId) throw new Error("attempt_binding_conflict");
      const attempt = attempts.rows[0];
      assertRecipientState({ status: attempt.result_state, attemptId: attempt.id,
        providerMessageId: attempt.provider_message_id, retryable: attempt.retryable });
      if (!Array.isArray(attempt.receipt_evidence) || attempt.receipt_evidence.length > 2
        || attempt.receipt_evidence.some(value => !id(value) || !/^[A-Za-z0-9:+._=/-]+$/.test(value))) throw new Error("corrupt_receipt_evidence");
      const retainedReceipts = [...new Set([...attempt.receipt_evidence as string[], ...receipts])];
      if (retainedReceipts.length > 2) throw new Error("receipt_evidence_conflict");
      if (attempt.provider_scope_digest !== lease.gate.template.scopeDigest
        || attempt.sender_phone_number_id !== lease.gate.channel.config.phoneNumberId) throw new Error("attempt_provider_binding_conflict");
      if (attempt.provider_message_id !== null) {
        if (outcome.status !== "accepted" || outcome.providerMessageId !== attempt.provider_message_id) throw new Error("provider_receipt_conflict");
        if (attempt.result_state === "accepted") {
          if (retainedReceipts.length !== attempt.receipt_evidence.length) {
            await tx.query(`UPDATE occasion_campaign_attempts SET receipt_evidence=$2::jsonb WHERE id=$1`, [attempt.id, JSON.stringify(retainedReceipts)]);
            await audit(tx, "occasion_campaign.receipt_evidence", campaign.id, { recipientId: String(claim.recipientId), attemptId: attempt.id });
          }
          return; // Preserve any later sent/delivered/read recipient state.
        }
      }
      if (attempt.result_state === "uncertain" && outcome.status === "rejected") throw new Error("uncertain_cannot_reject");
      const recipients = await tx.query<RecipientRow>(`SELECT * FROM occasion_campaign_recipients WHERE id=$1 AND campaign_id=$2 FOR UPDATE`, [claim.recipientId, claim.campaignId]);
      const recipient = recipients.rows[0];
      if (!recipient || recipient.current_attempt_id !== outcome.attemptId || !sameOccasionValue(recipient.snapshot, claim.snapshot)) throw new Error("attempt_recipient_conflict");
      recipientState(recipient);
      if (recipient.provider_message_id !== null && recipient.provider_message_id !== outcome.providerMessageId) throw new Error("recipient_receipt_conflict");
      await tx.query(`UPDATE occasion_campaign_attempts SET result_state=$2, provider_message_id=$3, retryable=$4,
        receipt_evidence=$5::jsonb, finished_at=clock_timestamp() WHERE id=$1`,
      [attempt.id, outcome.status, outcome.providerMessageId, outcome.retryable, JSON.stringify(retainedReceipts)]);
      await tx.query(`UPDATE occasion_campaign_recipients SET state=$2, provider_message_id=$3, retryable=$4,
        last_reason=$5, updated_at=clock_timestamp() WHERE id=$1 AND current_attempt_id=$6`,
      [claim.recipientId, outcome.status, outcome.providerMessageId, outcome.retryable,
        outcome.status === "uncertain" ? "provider_outcome_uncertain" : null, outcome.attemptId]);
      if (outcome.status === "uncertain") await tx.query(`UPDATE occasion_campaigns SET state='needs_attention', last_reason='uncertain', updated_at=clock_timestamp() WHERE id=$1`, [campaign.id]);
      await audit(tx, "occasion_campaign.outcome", campaign.id, { recipientId: String(claim.recipientId), attemptId: attempt.id, outcome: outcome.status });
    });
  }

  async function pause(input: CampaignBatchLease, reason: "uncertain" | "provider_stop" | "persistence_failure" | "invalid_state"): Promise<void> {
    const lease = immutableOccasionValue(input);
    await transact(false, async tx => {
      const row = await campaignOn(tx, lease.campaignId);
      if (row.authorization_id !== lease.authorizationId || row.lease_id !== lease.leaseId) throw new Error("stale_pause");
      await tx.query(`UPDATE occasion_campaign_attempts SET result_state='uncertain', retryable=FALSE, finished_at=clock_timestamp()
        WHERE campaign_id=$1 AND lease_id=$2 AND result_state='claimed'`, [row.id, lease.leaseId]);
      await tx.query(`UPDATE occasion_campaign_recipients r SET state='uncertain', retryable=FALSE, last_reason='paused_claim', updated_at=clock_timestamp()
        WHERE r.campaign_id=$1 AND r.state='claimed' AND EXISTS (SELECT 1 FROM occasion_campaign_attempts a WHERE a.id=r.current_attempt_id AND a.lease_id=$2)`, [row.id, lease.leaseId]);
      await tx.query(`UPDATE occasion_campaigns SET state='needs_attention', last_reason=$2, updated_at=clock_timestamp() WHERE id=$1`, [row.id, reason]);
      await audit(tx, "occasion_campaign.pause", row.id, { reason });
    });
  }

  async function release(input: CampaignBatchLease): Promise<void> {
    const lease = immutableOccasionValue(input);
    await transact(false, async tx => {
      const row = await campaignOn(tx, lease.campaignId);
      if (row.authorization_id !== lease.authorizationId || row.lease_id !== lease.leaseId) return;
      await tx.query(`UPDATE occasion_campaign_attempts SET result_state='uncertain', retryable=FALSE, finished_at=clock_timestamp()
        WHERE campaign_id=$1 AND lease_id=$2 AND result_state='claimed'`, [row.id, lease.leaseId]);
      await tx.query(`UPDATE occasion_campaign_recipients r SET state='uncertain', retryable=FALSE, last_reason='released_unresolved_claim', updated_at=clock_timestamp()
        WHERE r.campaign_id=$1 AND r.state='claimed' AND EXISTS(SELECT 1 FROM occasion_campaign_attempts a WHERE a.id=r.current_attempt_id AND a.lease_id=$2)`, [row.id, lease.leaseId]);
      await tx.query(`UPDATE occasion_campaign_batches SET completed_at=COALESCE(completed_at,clock_timestamp()), terminal_reason=COALESCE(terminal_reason,$2)
        WHERE lease_id=$1`, [lease.leaseId, row.last_reason ?? "batch_finished"]);
      await tx.query(`UPDATE occasion_campaigns SET lease_id=NULL, lease_expires_at=NULL,
        state=CASE WHEN state='needs_attention' OR EXISTS(SELECT 1 FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state IN ('claimed','uncertain')) THEN 'needs_attention'
          WHEN cancel_requested THEN 'cancelled'
          WHEN EXISTS(SELECT 1 FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state='queued') THEN 'queued' ELSE 'dispatch_complete' END,
        updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2`, [row.id, lease.leaseId]);
      await audit(tx, "occasion_campaign.batch_release", row.id);
    });
  }

  async function cancel(campaignId: string): Promise<void> {
    if (!id(campaignId)) throw new Error("invalid_campaign_id");
    await transact(true, async tx => {
      const row = await campaignOn(tx, campaignId);
      await tx.query(`UPDATE occasion_campaigns SET cancel_requested=TRUE,
        state=CASE WHEN state='needs_attention' OR EXISTS(SELECT 1 FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state='uncertain') THEN 'needs_attention'
          WHEN lease_id IS NULL THEN 'cancelled' ELSE state END, updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
      await tx.query(`UPDATE occasion_campaign_recipients SET state='cancelled', last_reason='campaign_cancelled', updated_at=clock_timestamp()
        WHERE campaign_id=$1 AND state='queued'`, [row.id]);
      await audit(tx, "occasion_campaign.cancel", row.id);
    });
  }

  async function suppressBeforeDispatch(inputLease: CampaignBatchLease, inputClaim: CampaignClaim): Promise<void> {
    const { lease, claim } = immutableOccasionValue({ lease: inputLease, claim: inputClaim });
    await transact(false, async tx => {
      const campaign = await campaignOn(tx, lease.campaignId);
      requireLease(campaign, lease);
      if (claim.campaignId !== campaign.id || claim.authorizationId !== lease.authorizationId) throw new Error("claim_binding_conflict");
      await lockMessagingEndpoint(tx, "whatsapp", claim.snapshot.endpoint);
      const result = await tx.query<RecipientRow>(`SELECT * FROM occasion_campaign_recipients WHERE id=$1 AND campaign_id=$2 FOR UPDATE`, [claim.recipientId, campaign.id]);
      const row = result.rows[0];
      if (!row || row.current_attempt_id !== claim.state.attemptId || row.state !== "claimed" || row.provider_message_id !== null
        || !sameOccasionValue(row.snapshot, claim.snapshot)) throw new Error("claim_changed");
      const changed = await tx.query(`UPDATE occasion_campaign_attempts SET result_state='rejected', retryable=FALSE, finished_at=clock_timestamp()
        WHERE id=$1 AND lease_id=$2 AND recipient_id=$3 AND result_state='claimed' AND provider_message_id IS NULL RETURNING id`,
      [row.current_attempt_id, lease.leaseId, claim.recipientId]);
      if (changed.rows.length !== 1) throw new Error("attempt_changed");
      await tx.query(`UPDATE occasion_campaign_recipients SET state='suppressed', retryable=FALSE, last_reason='pre_dispatch_suppression', updated_at=clock_timestamp() WHERE id=$1`, [claim.recipientId]);
      await audit(tx, "occasion_campaign.pre_dispatch_suppress", campaign.id, { recipientId: String(claim.recipientId) });
    });
  }

  async function retryRejected(campaignId: string, recipientIds: readonly number[], serverGate: OccasionSendGate): Promise<number> {
    const requested = immutableOccasionValue({ campaignId, recipientIds, gate: serverGate });
    const ids = [...new Set(requested.recipientIds)];
    if (!id(campaignId) || ids.length < 1 || ids.length > 100 || ids.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("invalid_retry_request");
    return transact(true, async tx => {
      const campaign = await campaignOn(tx, requested.campaignId);
      const explicitProviderStopRecovery = campaign.state === "needs_attention" && campaign.last_reason === "provider_stop";
      if (campaign.authorization_id === null || campaign.cancel_requested !== false || campaign.lease_live === true
        || (!["queued", "dispatch_complete"].includes(campaign.state) && !explicitProviderStopRecovery)
        || !occasionSendReadiness(requested.gate, deps.nowMs()).ok || await deps.bindingStillEnabledOn(tx, requested.gate) !== true
        || campaign.approved_content_digest !== requested.gate.approvedContentDigest
        || !sameOccasionValue(publicBinding(requested.gate), campaign.provider_binding)
        || !sameOccasionValue(stableTemplate(requested.gate.template), stableTemplate(campaign.approved_template))) throw new Error("retry_blocked");
      const unresolved = await tx.query(`SELECT 1 FROM occasion_campaign_recipients WHERE campaign_id=$1 AND state IN ('claimed','uncertain') LIMIT 1`, [campaign.id]);
      if (unresolved.rows.length > 0) throw new Error("retry_unresolved_campaign");
      const rows = await tx.query<RecipientRow>(`SELECT * FROM occasion_campaign_recipients WHERE campaign_id=$1 AND id=ANY($2::bigint[]) ORDER BY endpoint,id`, [campaign.id, ids]);
      if (rows.rows.length !== ids.length) throw new Error("retry_recipient_not_found");
      for (const candidate of rows.rows) {
        await lockMessagingEndpoint(tx, "whatsapp", candidate.endpoint);
        const locked = await tx.query<RecipientRow>(`SELECT * FROM occasion_campaign_recipients WHERE id=$1 FOR UPDATE`, [candidate.id]);
        const row = locked.rows[0];
        if (!row) throw new Error("retry_recipient_not_found");
        const current = row.patient_id !== null ? await eligibleOn(tx, row.snapshot) : null;
        if (!current) throw new Error("retry_consent_changed");
        retryRejectedRecipient(recipientState(row), { campaignActive: true, snapshot: row.snapshot, currentContact: current });
        const evidence = await tx.query(`SELECT 1 FROM occasion_campaign_attempts WHERE recipient_id=$1
          AND (provider_message_id IS NOT NULL OR result_state IN ('claimed','accepted','uncertain')) LIMIT 1`, [row.id]);
        if (evidence.rows.length > 0) throw new Error("retry_has_prior_acceptance_or_uncertainty");
        await tx.query(`UPDATE occasion_campaign_recipients SET state='queued', current_attempt_id=NULL, retryable=FALSE,
          last_reason=NULL, updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
      }
      await tx.query(`UPDATE occasion_campaigns SET state='queued', last_reason=NULL, updated_at=clock_timestamp() WHERE id=$1`, [campaign.id]);
      await audit(tx, "occasion_campaign.retry_authorize", campaign.id, { recipients: ids.length });
      return ids.length;
    });
  }

  /**
   * Final read-only gate inside withServerOwnedOutboundGuard's endpoint transaction.
   * No row locks here: claim was durable already and endpoint scope covers provider I/O.
   */
  async function canDispatchOn(executor: QueryExecutor, inputLease: CampaignBatchLease, inputClaim: CampaignClaim): Promise<boolean> {
    const { lease, claim } = immutableOccasionValue({ lease: inputLease, claim: inputClaim });
    assertRecipientState(claim.state);
    if (claim.state.status !== "claimed" || claim.authorizationId !== lease.authorizationId || claim.campaignId !== lease.campaignId
      || await deps.authorizeAdminOn(executor, actor.username) !== true || await deps.bindingStillEnabledOn(executor, lease.gate) !== true) return false;
    const campaigns = await executor.query<CampaignRow>(`SELECT *, COALESCE(lease_expires_at > clock_timestamp(), FALSE) AS lease_live
      FROM occasion_campaigns WHERE id=$1`, [lease.campaignId]);
    if (campaigns.rows.length !== 1) return false;
    try { requireLease(campaigns.rows[0], lease); } catch { return false; }
    const rows = await executor.query<RecipientRow>(`SELECT r.* FROM occasion_campaign_recipients r
      JOIN occasion_campaign_attempts a ON a.id=r.current_attempt_id
      WHERE r.id=$1 AND r.campaign_id=$2 AND r.endpoint=$3 AND r.state='claimed'
        AND r.current_attempt_id=$4 AND r.provider_message_id IS NULL
        AND a.result_state='claimed' AND a.provider_message_id IS NULL
        AND a.authorization_id=$5 AND a.lease_id=$6
        AND a.provider_scope_digest=$7 AND a.sender_phone_number_id=$8`,
    [claim.recipientId, claim.campaignId, claim.snapshot.endpoint, claim.state.attemptId, lease.authorizationId, lease.leaseId,
      lease.gate.template.scopeDigest, lease.gate.channel.config.phoneNumberId]);
    const row = rows.rows[0];
    if (rows.rows.length !== 1 || !row || row.patient_id === null || !sameOccasionValue(row.snapshot, claim.snapshot)) return false;
    recipientState(row);
    return await eligibleOn(executor, claim.snapshot) !== null;
  }

  return { authorizeCampaign, acquireBatch, claimNext, suppressBeforeDispatch, persistOutcome, pause, release, cancel, retryRejected, canDispatchOn };
}
