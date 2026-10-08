/**
 * Unpublished, channel-independent occasion campaign core for review.
 * No database, clock, network, provider readiness, or background execution.
 * All contact/consent/suppression inputs must come from authoritative server reads.
 * A prepared snapshot is NOT authorization or evidence of provider readiness.
 */
export type OccasionChannel = "whatsapp" | "sms";
export const OCCASION_PURPOSE = "occasion" as const;
export const isOccasionChannel = (value: unknown): value is OccasionChannel => value === "whatsapp" || value === "sms";

export type LocalPhoneCountry = "YE" | null;
export type PhoneResolution =
  | { ok: true; endpoint: string; source: "explicit_international" | "local_context" }
  | { ok: false; reason: "missing_phone" | "invalid_phone_syntax" | "local_country_required" | "unsupported_local_phone" };

/**
 * Explicit international syntax is preserved regardless of clinic location.
 * Local numbers require a configured country context; only YE local rules are provided here.
 * E.164-shaped syntax does not establish ownership, mobile service, reachability or provider support.
 */
export function resolveOccasionPhone(input: string | null | undefined, localCountry: LocalPhoneCountry): PhoneResolution {
  if (typeof input !== "string" || !input.trim()) return { ok: false, reason: "missing_phone" };
  const text = input.trim()
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  // Do not silently remove letters, extensions, multiple numbers, or URL syntax.
  if (!/^\+?[0-9 ()-]+$/.test(text)) return { ok: false, reason: "invalid_phone_syntax" };
  let digits = text.replace(/[ ()-]/g, "");
  if (!/^\+?\d+$/.test(digits)) return { ok: false, reason: "invalid_phone_syntax" };
  const international = digits.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  if (international) {
    return /^[1-9]\d{7,14}$/.test(digits)
      ? { ok: true, endpoint: digits, source: "explicit_international" }
      : { ok: false, reason: "invalid_phone_syntax" };
  }
  if (localCountry !== "YE") return { ok: false, reason: "local_country_required" };
  if (/^07\d{8}$/.test(digits)) digits = digits.slice(1);
  if (/^7\d{8}$/.test(digits)) digits = `967${digits}`;
  return /^9677\d{8}$/.test(digits)
    ? { ok: true, endpoint: digits, source: "local_context" }
    : { ok: false, reason: "unsupported_local_phone" };
}

export function normalizeOccasionPhone(input: string | null | undefined, localCountry: LocalPhoneCountry): string | null {
  const result = resolveOccasionPhone(input, localCountry);
  return result.ok ? result.endpoint : null;
}

export interface OccasionPermission {
  /** Opaque identifier for the latest immutable, purpose-specific consent event. */
  eventId: string;
  patientId: number;
  channel: OccasionChannel;
  purpose: typeof OCCASION_PURPOSE;
  endpoint: string;
  contactRevision: string;
  decision: "granted" | "withdrawn";
  /** Reference to recorded consent evidence; never the evidence's free text. */
  evidenceId: string | null;
}

export interface CandidateContact {
  patientId: number;
  phone: string | null;
  localCountry: LocalPhoneCountry;
  contactRevision: string;
  /** Must cover primary AND alternate phones across all linked records, without LIMIT. */
  identity: "unique" | "shared" | "unknown";
  permission: OccasionPermission | null;
  /** Resolved latest destination/channel suppression, regardless of patient attribution. */
  suppression: "clear" | "suppressed" | "unknown";
}

export interface RecipientSnapshot {
  patientId: number;
  channel: OccasionChannel;
  purpose: typeof OCCASION_PURPOSE;
  endpoint: string;
  contactRevision: string;
  consentEventId: string;
}

export type IneligibleReason =
  | "invalid_channel" | "invalid_patient" | "missing_phone" | "invalid_phone_syntax" | "local_country_required" | "unsupported_local_phone"
  | "suppressed" | "suppression_unknown"
  | "identity_ambiguous" | "consent_missing" | "consent_withdrawn"
  | "consent_mismatch" | "contact_changed" | "duplicate_destination" | "conflicting_snapshot";

export type Eligibility =
  | { eligible: true; recipient: Readonly<RecipientSnapshot> }
  | { eligible: false; reason: IneligibleReason };

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const validPatientId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export function evaluateOccasionRecipient(contact: CandidateContact, channel: OccasionChannel): Eligibility {
  if (!isOccasionChannel(channel)) return { eligible: false, reason: "invalid_channel" };
  if (!validPatientId(contact.patientId)) return { eligible: false, reason: "invalid_patient" };
  const resolution = resolveOccasionPhone(contact.phone, contact.localCountry);
  if (!resolution.ok) return { eligible: false, reason: resolution.reason };
  const endpoint = resolution.endpoint;
  // Suppression always takes precedence over grants or missing/ambiguous identity.
  if (contact.suppression === "suppressed") return { eligible: false, reason: "suppressed" };
  if (contact.suppression !== "clear") return { eligible: false, reason: "suppression_unknown" };
  if (contact.identity !== "unique") return { eligible: false, reason: "identity_ambiguous" };
  const permission = contact.permission;
  if (!permission) return { eligible: false, reason: "consent_missing" };
  if (permission.decision === "withdrawn") return { eligible: false, reason: "consent_withdrawn" };
  if (permission.decision !== "granted" || permission.patientId !== contact.patientId
    || permission.channel !== channel || permission.purpose !== OCCASION_PURPOSE
    || permission.endpoint !== endpoint || !nonempty(permission.eventId) || !nonempty(permission.evidenceId)) {
    return { eligible: false, reason: "consent_mismatch" };
  }
  if (!nonempty(contact.contactRevision) || permission.contactRevision !== contact.contactRevision) {
    return { eligible: false, reason: "contact_changed" };
  }
  return { eligible: true, recipient: Object.freeze({
    patientId: contact.patientId, channel, purpose: OCCASION_PURPOSE, endpoint,
    contactRevision: contact.contactRevision, consentEventId: permission.eventId,
  }) };
}

/** Conflicting rows for one endpoint are all excluded; do not select an arbitrary family member. */
export function prepareOccasionRecipients(contacts: readonly CandidateContact[], channel: OccasionChannel): {
  recipients: readonly Readonly<RecipientSnapshot>[];
  excluded: readonly { patientId: number; reason: IneligibleReason }[];
} {
  const identities = new Map<string, Set<number>>();
  const blockedEndpoints = new Map<string, IneligibleReason>();
  const endpointSnapshots = new Map<string, string>();
  for (const contact of contacts) {
    const endpoint = normalizeOccasionPhone(contact.phone, contact.localCountry);
    if (!endpoint) continue;
    const ids = identities.get(endpoint) ?? new Set<number>();
    ids.add(contact.patientId);
    identities.set(endpoint, ids);
    const eligibility = evaluateOccasionRecipient(contact, channel);
    if (!eligibility.eligible) {
      if (!blockedEndpoints.has(endpoint) || eligibility.reason === "suppressed") {
        blockedEndpoints.set(endpoint, eligibility.reason);
      }
    } else {
      const canonical = JSON.stringify(eligibility.recipient);
      const previous = endpointSnapshots.get(endpoint);
      if (ids.size === 1 && previous !== undefined && previous !== canonical && !blockedEndpoints.has(endpoint)) {
        blockedEndpoints.set(endpoint, "conflicting_snapshot");
      }
      endpointSnapshots.set(endpoint, canonical);
    }
  }
  const recipients: Readonly<RecipientSnapshot>[] = [];
  const excluded: { patientId: number; reason: IneligibleReason }[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    const result = evaluateOccasionRecipient(contact, channel);
    if (!result.eligible) {
      excluded.push({ patientId: contact.patientId, reason: result.reason });
      continue;
    }
    const { endpoint } = result.recipient;
    const blocked = blockedEndpoints.get(endpoint);
    if (blocked) {
      excluded.push({ patientId: contact.patientId, reason: blocked });
    } else if ((identities.get(endpoint)?.size ?? 0) !== 1) {
      excluded.push({ patientId: contact.patientId, reason: "identity_ambiguous" });
    } else if (seen.has(endpoint)) {
      excluded.push({ patientId: contact.patientId, reason: "duplicate_destination" });
    } else {
      seen.add(endpoint);
      recipients.push(result.recipient);
    }
  }
  recipients.sort((a, b) => a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0);
  return { recipients: Object.freeze(recipients), excluded: Object.freeze(excluded.map(row => Object.freeze(row))) };
}

/** Dispatch requires the exact approved contact and grant, not just any presently eligible record. */
export function recheckOccasionRecipient(snapshot: Readonly<RecipientSnapshot>, current: CandidateContact): Eligibility {
  if (snapshot.purpose !== OCCASION_PURPOSE) return { eligible: false, reason: "consent_mismatch" };
  const result = evaluateOccasionRecipient(current, snapshot.channel);
  if (!result.eligible) return result;
  const fresh = result.recipient;
  if (fresh.patientId !== snapshot.patientId || fresh.endpoint !== snapshot.endpoint
    || fresh.contactRevision !== snapshot.contactRevision || fresh.consentEventId !== snapshot.consentEventId) {
    return { eligible: false, reason: "contact_changed" };
  }
  return result;
}

/** Resolved from a trusted, reviewed, immutable preset registry, never a client-supplied body. */
export interface OccasionTemplateSnapshot {
  templateId: string;
  revision: string;
  channel: OccasionChannel;
  language: string;
  /** Fixed generic greeting only; no patient-specific variables, health data, or links. */
  body: string;
  /** Optional draft binding. A name is NOT proof that the provider has approved the template. */
  providerTemplateName: string | null;
}

export interface CampaignSnapshot {
  channel: OccasionChannel;
  purpose: typeof OCCASION_PURPOSE;
  template: Readonly<OccasionTemplateSnapshot>;
  recipients: readonly Readonly<RecipientSnapshot>[];
}

export function freezeOccasionSnapshot(
  template: OccasionTemplateSnapshot, recipients: readonly Readonly<RecipientSnapshot>[],
): Readonly<CampaignSnapshot> {
  if (!isOccasionChannel(template.channel) || !nonempty(template.templateId) || !nonempty(template.revision) || !nonempty(template.language)
    || !nonempty(template.body) || template.body.length > 4000 || /[{}]/.test(template.body)) {
    throw new Error("invalid_template_snapshot");
  }
  if (template.providerTemplateName !== null && !nonempty(template.providerTemplateName)) {
    throw new Error("invalid_template_binding");
  }
  const seen = new Set<string>();
  const rows = recipients.map(row => {
    if (!validPatientId(row.patientId) || row.channel !== template.channel || row.purpose !== OCCASION_PURPOSE
      || normalizeOccasionPhone(`+${row.endpoint}`, null) !== row.endpoint
      || !nonempty(row.contactRevision) || !nonempty(row.consentEventId) || seen.has(row.endpoint)) {
      throw new Error("invalid_recipient_snapshot");
    }
    seen.add(row.endpoint);
    return Object.freeze({
      patientId: row.patientId, channel: row.channel, purpose: row.purpose, endpoint: row.endpoint,
      contactRevision: row.contactRevision, consentEventId: row.consentEventId,
    });
  }).sort((a, b) => a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0);
  return Object.freeze({ channel: template.channel, purpose: OCCASION_PURPOSE, template: Object.freeze({
    templateId: template.templateId, revision: template.revision, channel: template.channel,
    language: template.language, body: template.body, providerTemplateName: template.providerTemplateName,
  }), recipients: Object.freeze(rows) });
}

export interface SendIntent {
  campaignId: string;
  draftRevision: number;
  idempotencyKey: string;
  /** Server-built canonical value; keep private because it includes recipient destinations. */
  canonicalSnapshot: string;
}

export function createSendIntent(input: {
  campaignId: string; draftRevision: number; idempotencyKey: string; snapshot: Readonly<CampaignSnapshot>;
}): Readonly<SendIntent> {
  if (!nonempty(input.campaignId) || !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 1
    || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) throw new Error("invalid_send_intent");
  const snapshot = freezeOccasionSnapshot(input.snapshot.template, input.snapshot.recipients);
  if (snapshot.channel !== input.snapshot.channel || input.snapshot.purpose !== OCCASION_PURPOSE
    || snapshot.recipients.length === 0) throw new Error("empty_or_inconsistent_send_intent");
  return Object.freeze({
    campaignId: input.campaignId, draftRevision: input.draftRevision, idempotencyKey: input.idempotencyKey,
    canonicalSnapshot: JSON.stringify(snapshot),
  });
}

/** Must be checked atomically under a campaign row lock and unique dispatch constraint. */
export function compareSendIntent(existing: Readonly<SendIntent> | null, proposed: Readonly<SendIntent>): "new" | "replay" | "conflict" {
  if (existing === null) return "new";
  // A different key does not authorize a second dispatch of the same campaign.
  return existing.campaignId === proposed.campaignId && existing.draftRevision === proposed.draftRevision
    && existing.canonicalSnapshot === proposed.canonicalSnapshot ? "replay" : "conflict";
}

export type RecipientStatus = "queued" | "claimed" | "accepted" | "sent" | "delivered" | "read"
  | "rejected" | "failed" | "uncertain" | "cancelled" | "suppressed";
export type RecipientState =
  | { status: "queued" | "cancelled"; attemptId: null; providerMessageId: null; retryable: false }
  | { status: "claimed"; attemptId: string; providerMessageId: null; retryable: false }
  | { status: "accepted" | "sent" | "delivered" | "read" | "failed"; attemptId: string; providerMessageId: string; retryable: false }
  | { status: "rejected"; attemptId: string; providerMessageId: null; retryable: boolean }
  | { status: "uncertain"; attemptId: string; providerMessageId: string | null; retryable: false }
  | { status: "suppressed"; attemptId: string | null; providerMessageId: null; retryable: false };

const validEvidenceId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();

/**
 * Closed runtime boundary for DB/adapter data. Contradictory receipt evidence is
 * corruption, never permission to reset to queued. Keep DB row projection explicit;
 * extra fields and unknown future states must be reviewed instead of silently accepted.
 */
export function isRecipientState(value: unknown): value is RecipientState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const fields = ["status", "attemptId", "providerMessageId", "retryable"];
  if (Object.keys(row).length !== fields.length || !fields.every(key => Object.hasOwn(row, key))) return false;
  if (typeof row.retryable !== "boolean") return false;
  const noReceipt = row.providerMessageId === null;
  const hasReceipt = validEvidenceId(row.providerMessageId);
  const noAttempt = row.attemptId === null;
  const hasAttempt = validEvidenceId(row.attemptId);
  switch (row.status) {
    case "queued": case "cancelled":
      return noAttempt && noReceipt && row.retryable === false;
    case "claimed":
      return hasAttempt && noReceipt && row.retryable === false;
    case "accepted": case "sent": case "delivered": case "read": case "failed":
      return hasAttempt && hasReceipt && row.retryable === false;
    case "rejected":
      return hasAttempt && noReceipt;
    case "uncertain":
      return hasAttempt && (noReceipt || hasReceipt) && row.retryable === false;
    case "suppressed":
      return (noAttempt || hasAttempt) && noReceipt && row.retryable === false;
    default:
      return false;
  }
}

export function assertRecipientState(value: unknown): asserts value is RecipientState {
  if (!isRecipientState(value)) throw new Error("invalid_recipient_state");
}
export const queuedRecipient = (): Readonly<RecipientState> => Object.freeze({
  status: "queued", attemptId: null, providerMessageId: null, retryable: false,
});

/** Precondition: claim, latest consent recheck, cancellation gate and attempt insertion are atomic. */
export function claimRecipient(state: Readonly<RecipientState>, input: {
  campaignActive: boolean; snapshot: Readonly<RecipientSnapshot>; currentContact: CandidateContact; attemptId: string;
}): Readonly<RecipientState> {
  assertRecipientState(state);
  if (state.status !== "queued") throw new Error("recipient_not_queued");
  if (state.providerMessageId !== null) throw new Error("provider_receipt_prevents_claim");
  if (input.campaignActive !== true) throw new Error("campaign_not_active");
  if (!recheckOccasionRecipient(input.snapshot, input.currentContact).eligible) return Object.freeze({ ...state, status: "suppressed" });
  if (!validEvidenceId(input.attemptId)) throw new Error("invalid_attempt_id");
  return Object.freeze({ status: "claimed", attemptId: input.attemptId, providerMessageId: null, retryable: false });
}

export type DispatchOutcome =
  /** Only a validated provider acceptance receipt, never an HTTP status alone. */
  | { kind: "accepted"; providerMessageId: string }
  /** Adapter proves that this attempt was not accepted; do not infer this from transport failure. */
  | { kind: "not_accepted"; retryable: boolean }
  | { kind: "unknown" };

export function applyDispatchOutcome(state: Readonly<RecipientState>, attemptId: string, outcome: DispatchOutcome): Readonly<RecipientState> {
  assertRecipientState(state);
  if (state.status !== "claimed" || !validEvidenceId(attemptId) || state.attemptId !== attemptId) throw new Error("stale_dispatch_attempt");
  const uncertain = (): Readonly<RecipientState> => Object.freeze({ ...state, status: "uncertain", retryable: false });
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return uncertain();
  const expectedFields = outcome.kind === "accepted" ? ["kind", "providerMessageId"]
    : outcome.kind === "not_accepted" ? ["kind", "retryable"] : ["kind"];
  // In particular, never discard an unexpected receipt attached to a claimed rejection.
  if (Object.keys(outcome).length !== expectedFields.length || !expectedFields.every(key => Object.hasOwn(outcome, key))) return uncertain();
  if (outcome.kind === "accepted" && validEvidenceId(outcome.providerMessageId)) return Object.freeze({
    ...state, status: "accepted", providerMessageId: outcome.providerMessageId, retryable: false,
  });
  if (outcome.kind === "not_accepted" && typeof outcome.retryable === "boolean") {
    return Object.freeze({ ...state, status: "rejected", retryable: outcome.retryable });
  }
  // Includes a purported success without a usable receipt, timeout, or uncertain crash recovery.
  return uncertain();
}

/** A lost claim is unsafe to resend: the process may have died after the provider accepted it. */
export function expireClaim(state: Readonly<RecipientState>, attemptId: string): Readonly<RecipientState> {
  return applyDispatchOutcome(state, attemptId, { kind: "unknown" });
}

export function cancelUnclaimedRecipient(state: Readonly<RecipientState>): Readonly<RecipientState> {
  assertRecipientState(state);
  return state.status === "queued" ? Object.freeze({ ...state, status: "cancelled" }) : state;
}

/** Scheduling/backoff belongs to the durable runner, which is deliberately not selected here. */
export function retryRejectedRecipient(state: Readonly<RecipientState>, input: {
  campaignActive: boolean; snapshot: Readonly<RecipientSnapshot>; currentContact: CandidateContact;
}): Readonly<RecipientState> {
  assertRecipientState(state);
  if (state.status !== "rejected" || state.retryable !== true || input.campaignActive !== true) throw new Error("retry_not_allowed");
  if (state.providerMessageId !== null) throw new Error("provider_receipt_prevents_retry");
  if (!recheckOccasionRecipient(input.snapshot, input.currentContact).eligible) return Object.freeze({ ...state, status: "suppressed", retryable: false });
  return queuedRecipient();
}

const DELIVERY_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 } as const;
/** Authentication/account/endpoint validation must happen before calling this pure transition. */
export function applyDeliveryStatus(state: Readonly<RecipientState>, event: {
  attemptId: string; providerMessageId: string; status: "sent" | "delivered" | "read" | "failed";
}): Readonly<RecipientState> {
  assertRecipientState(state);
  if (!validEvidenceId(event.attemptId) || !validEvidenceId(event.providerMessageId)
    || !["sent", "delivered", "read", "failed"].includes(event.status)) throw new Error("invalid_delivery_event");
  if (state.attemptId !== event.attemptId
    || state.providerMessageId !== event.providerMessageId) throw new Error("unmatched_delivery_event");
  // Only a previously known exact receipt can reconcile an uncertain attempt here.
  // An uncertain attempt without a receipt cannot be matched by guessing the phone.
  if (state.status === "uncertain") return Object.freeze({
    status: event.status, attemptId: event.attemptId, providerMessageId: event.providerMessageId, retryable: false,
  });
  if (state.status === "failed" && (event.status === "delivered" || event.status === "read")) {
    return Object.freeze({ ...state, status: event.status, retryable: false });
  }
  if (state.status !== "accepted" && state.status !== "sent" && state.status !== "delivered" && state.status !== "read") return state;
  if (event.status === "failed") {
    // A late failure must not overwrite evidence that delivery/read already occurred.
    return state.status === "delivered" || state.status === "read" ? state
      : Object.freeze({ ...state, status: "failed", retryable: false });
  }
  return DELIVERY_RANK[event.status] > DELIVERY_RANK[state.status as keyof typeof DELIVERY_RANK]
    ? Object.freeze({ ...state, status: event.status, retryable: false }) : state;
}

export function campaignDispatchPhase(states: readonly Readonly<RecipientState>[], input: {
  sendAuthorized: boolean; cancelRequested: boolean;
}): "draft" | "queued" | "running" | "cancelling" | "cancelled" | "dispatch_complete" | "needs_attention" {
  states.forEach(assertRecipientState);
  if (typeof input.sendAuthorized !== "boolean" || typeof input.cancelRequested !== "boolean") throw new Error("invalid_campaign_flags");
  if (input.sendAuthorized !== true) return "draft";
  if (states.some(state => state.status === "claimed")) return input.cancelRequested ? "cancelling" : "running";
  if (states.some(state => state.status === "uncertain")) return "needs_attention";
  if (input.cancelRequested === true) {
    // Cancellation remains in progress until the transaction cancels every unclaimed row.
    return states.some(state => state.status === "queued") ? "cancelling" : "cancelled";
  }
  if (states.some(state => state.status === "queued")) return "queued";
  return "dispatch_complete"; // This says nothing about delivery to recipients.
}
