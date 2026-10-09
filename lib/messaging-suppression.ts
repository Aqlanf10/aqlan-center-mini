/**
 * Unpublished, dependency-injected source contract. No db.ts, providers, clocks,
 * environment flags, routes, schema registration, or database work on import.
 * Transaction adapters MUST use one connection and resolve only after COMMIT.
 */
import { isOccasionChannel, normalizeOccasionPhone, recheckOccasionRecipient,
  type CandidateContact, type LocalPhoneCountry, type OccasionChannel,
  type OccasionPermission, type RecipientSnapshot } from "./occasion-campaign-core";

export type MessagingChannel = OccasionChannel | "email";
export interface QueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}
export interface TransactionHost {
  /** READ COMMITTED, one connection, resolves after COMMIT. Never auto-retry provider I/O. */
  transaction<T>(work: (executor: QueryExecutor) => Promise<T>): Promise<T>;
}
export interface EndpointSuppression {
  status: "clear" | "suppressed";
  latestStopEventId: string | null;
  clearingResubscriptionEventId: string | null;
}

const opaque = (value: unknown, max = 200): value is string => typeof value === "string"
  && value.length > 0 && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const patientIdValid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const channelValid = (value: unknown): value is MessagingChannel => isOccasionChannel(value) || value === "email";

/** Existing app compatibility: the entire email address is case-folded. */
export function canonicalMessagingEndpoint(channel: MessagingChannel, value: string,
  localCountry: LocalPhoneCountry = null): string | null {
  if (!channelValid(channel) || typeof value !== "string") return null;
  if (channel !== "email") return normalizeOccasionPhone(value, localCountry);
  const endpoint = value.trim().toLowerCase();
  const disallowed = ["<", ">", ",", ";", ":", '"', "\\", "(", ")", "[", "]"];
  return endpoint.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(endpoint)
    && !disallowed.some(character => endpoint.includes(character))
    && !/[\x00-\x1f\x7f]/.test(endpoint) ? endpoint : null;
}

/** DB helpers accept canonical endpoints only; no guessing country or last-nine matching. */
function assertEndpoint(channel: MessagingChannel, endpoint: string): void {
  if (!channelValid(channel) || typeof endpoint !== "string"
    || (channel === "email" ? canonicalMessagingEndpoint(channel, endpoint) !== endpoint
      : !/^[1-9]\d{7,14}$/.test(endpoint))) throw new Error("invalid_canonical_messaging_endpoint");
}
function instant(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("invalid_evidence_time");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_evidence_time");
  return date.toISOString();
}
const optionalOpaque = (value: unknown): value is string | null => value === null || opaque(value);

/**
 * Same transaction-scoped lock for STOP, resubscribe, consent and ALL outbound I/O.
 * Hash collisions cause extra serialization, not endpoint identity equivalence.
 * Requires an active READ COMMITTED transaction, never a pool facade. A prior
 * repeatable-read snapshot could otherwise miss a STOP committed while waiting.
 */
export async function lockMessagingEndpoint(executor: QueryExecutor, channel: MessagingChannel,
  endpoint: string): Promise<void> {
  assertEndpoint(channel, endpoint);
  await executor.query(`/* messaging:endpoint-lock */
    SELECT pg_advisory_xact_lock(hashtextextended('messaging:endpoint:v1:' || $1::text || ':' || $2::text, 0))`,
  [channel, endpoint]);
}

/**
 * Authoritative append-only log read. Call under the endpoint lock when making a
 * send/write decision. No STOP evidence is clear; a missing result/table or error throws.
 * Database insertion sequence orders decisions, not untrusted provider timestamps.
 */
export async function readEndpointSuppressionOn(executor: QueryExecutor, channel: MessagingChannel,
  endpoint: string): Promise<EndpointSuppression> {
  assertEndpoint(channel, endpoint);
  const result = await executor.query<{ stop_id: unknown; clear_id: unknown }>(`
    /* messaging:read-suppression */
    WITH latest_stop AS (
      SELECT event_id, sequence FROM messaging_endpoint_events
      WHERE channel = $1 AND endpoint = $2 AND kind = 'stop'
      ORDER BY sequence DESC LIMIT 1
    ), latest_clear AS (
      SELECT e.event_id FROM messaging_endpoint_events e JOIN latest_stop s
        ON e.target_stop_event_id = s.event_id AND e.sequence > s.sequence
      WHERE e.channel = $1 AND e.endpoint = $2 AND e.kind = 'resubscribe'
      ORDER BY e.sequence DESC LIMIT 1
    )
    SELECT s.event_id AS stop_id, c.event_id AS clear_id
    FROM (SELECT 1) anchor LEFT JOIN latest_stop s ON true LEFT JOIN latest_clear c ON true`, [channel, endpoint]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !optionalOpaque(row.stop_id) || !optionalOpaque(row.clear_id)
    || (row.stop_id === null && row.clear_id !== null)) throw new Error("invalid_suppression_read");
  return Object.freeze({ status: row.stop_id !== null && row.clear_id === null ? "suppressed" : "clear",
    latestStopEventId: row.stop_id, clearingResubscriptionEventId: row.clear_id });
}

/**
 * Server-only authenticated evidence, produced by an upstream verifier/inbox.
 * Source scopes MUST include provider/account identity. IDs/references must be
 * stable across redelivery; none may be accepted from an unauthenticated body.
 * This type does not itself perform or prove cryptographic authentication.
 */
export interface AuthenticatedEndpointSignal {
  channel: MessagingChannel;
  endpoint: string;
  source: string;
  sourceEventId: string;
  evidenceId: string;
  authenticationEvidenceId: string;
  occurredAt: string;
}
export interface ExplicitEndpointResubscription extends AuthenticatedEndpointSignal {
  targetStopEventId: string;
  /** Upstream evidence must explicitly bind resubscription to the named latest STOP. */
  explicitResubscription: true;
}
interface EndpointEvent extends Record<string, unknown> {
  event_id: string; channel: MessagingChannel; endpoint: string; kind: "stop" | "resubscribe";
  target_stop_event_id: string | null; source: string; source_event_id: string;
  evidence_id: string; authentication_evidence_id: string; occurred_at: string;
}
type EndpointWrite = AuthenticatedEndpointSignal & { kind: "stop" | "resubscribe"; targetStopEventId: string | null };
export interface EndpointWriteResult {
  eventId: string; replayed: boolean; suppression: EndpointSuppression;
}
export interface EndpointWriteDeps extends TransactionHost { newEventId(): string }
export interface StopWriteDeps extends EndpointWriteDeps {
  /**
   * Same transaction, endpoint lock already held. Suppress queued rows only.
   * Do not acquire campaign rows, send acknowledgments, or perform provider I/O.
   * Any failure aborts persistence and must produce a retryable ingress error.
   */
  suppressQueuedOn(executor: QueryExecutor, input: Readonly<{
    channel: MessagingChannel; endpoint: string; stopEventId: string;
  }>): Promise<void>;
}

function signalSnapshot(input: AuthenticatedEndpointSignal): Readonly<AuthenticatedEndpointSignal> {
  assertEndpoint(input.channel, input.endpoint);
  if (!opaque(input.source) || !opaque(input.sourceEventId, 300) || !opaque(input.evidenceId)
    || !opaque(input.authenticationEvidenceId)) throw new Error("invalid_endpoint_evidence");
  return Object.freeze({ channel: input.channel, endpoint: input.endpoint, source: input.source,
    sourceEventId: input.sourceEventId, evidenceId: input.evidenceId,
    authenticationEvidenceId: input.authenticationEvidenceId, occurredAt: instant(input.occurredAt) });
}
async function findEndpointEventOn(executor: QueryExecutor, input: EndpointWrite): Promise<EndpointEvent | null> {
  const result = await executor.query<EndpointEvent>(`/* messaging:find-endpoint-event */
    SELECT event_id, channel, endpoint, kind, target_stop_event_id, source, source_event_id,
      evidence_id, authentication_evidence_id,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
    FROM messaging_endpoint_events WHERE source = $1 AND source_event_id = $2`, [input.source, input.sourceEventId]);
  if (result.rows.length > 1) throw new Error("invalid_endpoint_evidence_read");
  return result.rows[0] ?? null;
}
function assertSameEndpointEvent(row: EndpointEvent, input: EndpointWrite): void {
  if (!opaque(row.event_id) || row.channel !== input.channel || row.endpoint !== input.endpoint
    || row.kind !== input.kind || row.target_stop_event_id !== input.targetStopEventId
    || row.source !== input.source || row.source_event_id !== input.sourceEventId
    || row.evidence_id !== input.evidenceId || row.authentication_evidence_id !== input.authenticationEvidenceId
    || row.occurred_at !== input.occurredAt) throw new Error("endpoint_event_replay_conflict");
}
async function appendEndpointEventOn(executor: QueryExecutor, input: EndpointWrite,
  deps: EndpointWriteDeps): Promise<{ eventId: string; replayed: boolean }> {
  const eventId = deps.newEventId();
  if (!opaque(eventId)) throw new Error("invalid_endpoint_event_id");
  const inserted = await executor.query<{ event_id: string }>(`/* messaging:append-endpoint-event */
    INSERT INTO messaging_endpoint_events
      (event_id, channel, endpoint, kind, target_stop_event_id, source, source_event_id,
        evidence_id, authentication_evidence_id, occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
    ON CONFLICT (source, source_event_id) DO NOTHING RETURNING event_id`,
  [eventId, input.channel, input.endpoint, input.kind, input.targetStopEventId, input.source,
    input.sourceEventId, input.evidenceId, input.authenticationEvidenceId, input.occurredAt]);
  if (inserted.rows.length === 1 && inserted.rows[0]?.event_id === eventId) return { eventId, replayed: false };
  if (inserted.rows.length !== 0) throw new Error("invalid_endpoint_event_insert");
  // Handles same provider key racing across DIFFERENT endpoint locks. Never
  // reinterpret a globally conflicting key as an event for this destination.
  const existing = await findEndpointEventOn(executor, input);
  if (!existing) throw new Error("endpoint_event_insert_unconfirmed");
  assertSameEndpointEvent(existing, input);
  return { eventId: existing.event_id, replayed: true };
}

export async function recordAuthenticatedEndpointStop(input: AuthenticatedEndpointSignal,
  deps: StopWriteDeps): Promise<EndpointWriteResult> {
  const signal: EndpointWrite = Object.freeze({ ...signalSnapshot(input), kind: "stop", targetStopEventId: null });
  return deps.transaction(async executor => {
    await lockMessagingEndpoint(executor, signal.channel, signal.endpoint);
    const existing = await findEndpointEventOn(executor, signal);
    if (existing) {
      assertSameEndpointEvent(existing, signal);
      // Replay is observation only. An old STOP must not suppress a new queue
      // after a legitimate later resubscription, nor insert another stop event.
      return { eventId: existing.event_id, replayed: true,
        suppression: await readEndpointSuppressionOn(executor, signal.channel, signal.endpoint) };
    }
    const appended = await appendEndpointEventOn(executor, signal, deps);
    if (!appended.replayed) await deps.suppressQueuedOn(executor, Object.freeze({
      channel: signal.channel, endpoint: signal.endpoint, stopEventId: appended.eventId,
    }));
    const suppression = await readEndpointSuppressionOn(executor, signal.channel, signal.endpoint);
    if (!appended.replayed && (suppression.status !== "suppressed" || suppression.latestStopEventId !== appended.eventId)) {
      throw new Error("stop_persistence_not_authoritative");
    }
    return { ...appended, suppression };
  });
}

/** General consent grants, patient merges and inbound replies never call this helper. */
export async function recordExplicitEndpointResubscription(input: ExplicitEndpointResubscription,
  deps: EndpointWriteDeps): Promise<EndpointWriteResult> {
  if (input.explicitResubscription !== true || !opaque(input.targetStopEventId)) throw new Error("explicit_resubscription_required");
  const signal: EndpointWrite = Object.freeze({ ...signalSnapshot(input), kind: "resubscribe", targetStopEventId: input.targetStopEventId });
  return deps.transaction(async executor => {
    await lockMessagingEndpoint(executor, signal.channel, signal.endpoint);
    const existing = await findEndpointEventOn(executor, signal);
    if (existing) {
      assertSameEndpointEvent(existing, signal);
      return { eventId: existing.event_id, replayed: true,
        suppression: await readEndpointSuppressionOn(executor, signal.channel, signal.endpoint) };
    }
    const current = await readEndpointSuppressionOn(executor, signal.channel, signal.endpoint);
    if (current.status !== "suppressed" || current.latestStopEventId !== signal.targetStopEventId) {
      throw new Error("resubscription_must_reference_latest_active_stop");
    }
    const appended = await appendEndpointEventOn(executor, signal, deps);
    const suppression = await readEndpointSuppressionOn(executor, signal.channel, signal.endpoint);
    if (!appended.replayed && (suppression.status !== "clear" || suppression.latestStopEventId !== signal.targetStopEventId
      || suppression.clearingResubscriptionEventId !== appended.eventId)) throw new Error("resubscription_persistence_not_authoritative");
    return { ...appended, suppression };
  });
}

/**
 * An authenticated STOP cannot become a 2xx because sends/feature are disabled.
 * Authenticate/extract BEFORE any optional feature gate, then commit persistence.
 * Do not echo exception text, phone/email, evidence, secrets, or patient details.
 */
export async function ingestEndpointStop(raw: unknown, deps: StopWriteDeps & {
  authenticateStop(raw: unknown): Promise<AuthenticatedEndpointSignal | null>;
}): Promise<{ status: 200 | 403 | 503 }> {
  let signal: AuthenticatedEndpointSignal | null;
  try { signal = await deps.authenticateStop(raw); } catch { return { status: 503 }; }
  if (!signal) return { status: 403 };
  try { await recordAuthenticatedEndpointStop(signal, deps); return { status: 200 }; }
  catch { return { status: 503 }; }
}

interface ContactRevisionRow extends Record<string, unknown> {
  contact_revision: string; active: boolean;
}
/** Read-only; decision callers must already own the relevant endpoint lock. */
export async function readActiveContactRevisionOn(executor: QueryExecutor, patientId: number): Promise<string | null> {
  if (!patientIdValid(patientId)) throw new Error("invalid_patient_id");
  const result = await executor.query<ContactRevisionRow>(`/* messaging:read-contact-revision */
    SELECT p.contact_revision, e.active FROM patient_contact_revisions p
    JOIN patient_contact_revision_events e ON e.patient_id = p.patient_id AND e.contact_revision = p.contact_revision
    WHERE p.patient_id = $1`, [patientId]);
  if (result.rows.length > 1) throw new Error("invalid_contact_revision_read");
  const row = result.rows[0];
  if (!row) return null;
  if (!opaque(row.contact_revision) || typeof row.active !== "boolean") throw new Error("invalid_contact_revision_read");
  return row.active ? row.contact_revision : null;
}
export type ContactRevisionReason = "initialize" | "contact_change" | "merge_survivor" | "merge_retired" | "patient_deleted";

/**
 * Call in the SAME transaction as the actual contact/merge/delete operation.
 * Caller first locks all OLD + NEW canonical endpoints in sorted order, before
 * patient rows/revision rows. This helper alone does not update patient contacts.
 * New revision is globally fresh; never copy/reuse a revision on merge/recreation.
 */
export async function recordContactRevisionOn(executor: QueryExecutor, input: {
  patientId: number; expectedRevision: string | null; newRevision: string;
  reason: ContactRevisionReason; evidenceId: string;
}): Promise<string> {
  const value = Object.freeze({ ...input });
  if (!patientIdValid(value.patientId) || !optionalOpaque(value.expectedRevision)
    || !opaque(value.newRevision) || !opaque(value.evidenceId)
    || !["initialize", "contact_change", "merge_survivor", "merge_retired", "patient_deleted"].includes(value.reason)
    || (value.reason === "initialize") !== (value.expectedRevision === null)
    || value.newRevision === value.expectedRevision) throw new Error("invalid_contact_revision_event");
  // Covers first initialization when the pointer row does not exist yet.
  await executor.query(`/* messaging:contact-revision-lock */
    SELECT pg_advisory_xact_lock(hashtextextended('messaging:patient-contact:v1:' || $1::text, 0))`, [value.patientId]);
  const existing = await executor.query<ContactRevisionRow>(`/* messaging:lock-contact-revision */
    SELECT p.contact_revision, e.active FROM patient_contact_revisions p
    JOIN patient_contact_revision_events e ON e.patient_id = p.patient_id AND e.contact_revision = p.contact_revision
    WHERE p.patient_id = $1 FOR UPDATE OF p`, [value.patientId]);
  if (existing.rows.length > 1) throw new Error("invalid_contact_revision_read");
  const row = existing.rows[0];
  if ((row?.contact_revision ?? null) !== value.expectedRevision || (row && row.active !== true)) {
    throw new Error("stale_or_retired_contact_revision");
  }
  const active = ["initialize", "contact_change", "merge_survivor"].includes(value.reason);
  const event = await executor.query<{ contact_revision: string }>(`/* messaging:append-contact-revision */
    INSERT INTO patient_contact_revision_events
      (contact_revision, patient_id, previous_contact_revision, reason, active, evidence_id)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING contact_revision`,
  [value.newRevision, value.patientId, value.expectedRevision, value.reason, active, value.evidenceId]);
  if (event.rows.length !== 1 || event.rows[0]?.contact_revision !== value.newRevision) throw new Error("contact_revision_insert_unconfirmed");
  const pointer = await executor.query<{ contact_revision: string }>(`/* messaging:advance-contact-revision */
    INSERT INTO patient_contact_revisions (patient_id, contact_revision) VALUES ($1,$2)
    ON CONFLICT (patient_id) DO UPDATE SET contact_revision = EXCLUDED.contact_revision
    RETURNING contact_revision`, [value.patientId, value.newRevision]);
  if (pointer.rows.length !== 1 || pointer.rows[0]?.contact_revision !== value.newRevision) throw new Error("contact_revision_update_unconfirmed");
  return value.newRevision;
}

export interface OccasionPermissionKey {
  patientId: number; channel: OccasionChannel; endpoint: string; contactRevision: string;
}
export interface ExplicitOccasionPermission extends OccasionPermissionKey {
  decision: "granted" | "withdrawn";
  evidenceKind: "explicit_occasion_opt_in" | "explicit_occasion_withdrawal";
  evidenceId: string; source: string; sourceEventId: string; occurredAt: string;
}
interface PermissionEventRow extends Record<string, unknown> {
  event_id: string; patient_id: string; channel: OccasionChannel; endpoint: string;
  purpose: "occasion"; contact_revision: string; decision: "granted" | "withdrawn";
  evidence_kind: ExplicitOccasionPermission["evidenceKind"]; evidence_id: string;
  source: string; source_event_id: string; occurred_at: string;
}
function assertPermissionKey(input: OccasionPermissionKey): void {
  if (!patientIdValid(input.patientId) || !isOccasionChannel(input.channel) || !opaque(input.contactRevision)) {
    throw new Error("invalid_occasion_permission_key");
  }
  assertEndpoint(input.channel, input.endpoint);
}
const PERMISSION_COLUMNS = `event_id, patient_id::text AS patient_id, channel, endpoint, purpose,
  contact_revision, decision, evidence_kind, evidence_id, source, source_event_id,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at`;

export async function readOccasionPermissionOn(executor: QueryExecutor, input: OccasionPermissionKey): Promise<OccasionPermission | null> {
  const key = Object.freeze({ ...input });
  assertPermissionKey(key);
  const result = await executor.query<PermissionEventRow>(`/* messaging:read-occasion-permission */
    SELECT ${PERMISSION_COLUMNS} FROM occasion_permission_events
    WHERE patient_id = $1 AND channel = $2 AND endpoint = $3 AND purpose = 'occasion' AND contact_revision = $4
    ORDER BY sequence DESC LIMIT 1`, [key.patientId, key.channel, key.endpoint, key.contactRevision]);
  if (result.rows.length > 1) throw new Error("invalid_occasion_permission_read");
  const row = result.rows[0];
  if (!row) return null;
  if (!opaque(row.event_id) || row.patient_id !== String(key.patientId) || row.channel !== key.channel
    || row.endpoint !== key.endpoint || row.purpose !== "occasion" || row.contact_revision !== key.contactRevision
    || !opaque(row.evidence_id) || !["granted", "withdrawn"].includes(row.decision)
    || row.evidence_kind !== (row.decision === "granted" ? "explicit_occasion_opt_in" : "explicit_occasion_withdrawal")) {
    throw new Error("invalid_occasion_permission_read");
  }
  return Object.freeze({ eventId: row.event_id, patientId: key.patientId, channel: key.channel,
    endpoint: key.endpoint, purpose: "occasion", contactRevision: key.contactRevision,
    decision: row.decision, evidenceId: row.evidence_id });
}

/** Not implemented by this packet: authoritative, unbounded full-contact identity lookup. */
export interface AuthoritativeContactProjection {
  patientId: number; phone: string | null; localCountry: LocalPhoneCountry;
  contactRevision: string; identity: "unique" | "shared" | "unknown";
}
export interface ContactProjectionDeps {
  /**
   * Read live patient existence, actual primary/alternate endpoint selection and
   * every owning record for the full canonical destination, with no LIMIT or
   * suffix matching. Unknown/missing mappings must never become identity=unique.
   * Reads and every contact mutation must follow the endpoint lock protocol.
   */
  readPatientContactProjectionOn(executor: QueryExecutor, input: Readonly<{
    patientId: number; channel: OccasionChannel; endpoint: string; localCountry: LocalPhoneCountry;
  }>): Promise<AuthoritativeContactProjection | null>;
}
export async function readOccasionCandidateOn(executor: QueryExecutor, input: {
  patientId: number; channel: OccasionChannel; endpoint: string; localCountry: LocalPhoneCountry;
  expectedContactRevision?: string;
}, deps: ContactProjectionDeps): Promise<CandidateContact | null> {
  const key = Object.freeze({ ...input });
  if (!patientIdValid(key.patientId) || !isOccasionChannel(key.channel)
    || ![null, "YE"].includes(key.localCountry)
    || (key.expectedContactRevision !== undefined && !opaque(key.expectedContactRevision))) throw new Error("invalid_contact_projection_request");
  await lockMessagingEndpoint(executor, key.channel, key.endpoint);
  const revision = await readActiveContactRevisionOn(executor, key.patientId);
  if (!revision || (key.expectedContactRevision !== undefined && revision !== key.expectedContactRevision)) return null;
  const original = await deps.readPatientContactProjectionOn(executor, key);
  if (!original) return null;
  const contact = Object.freeze({ ...original });
  if (contact.patientId !== key.patientId || contact.contactRevision !== revision
    || contact.localCountry !== key.localCountry || normalizeOccasionPhone(contact.phone, contact.localCountry) !== key.endpoint
    || !["unique", "shared", "unknown"].includes(contact.identity)) return null;
  const suppression = await readEndpointSuppressionOn(executor, key.channel, key.endpoint);
  const permission = await readOccasionPermissionOn(executor, { ...key, contactRevision: revision });
  return Object.freeze({ patientId: key.patientId, phone: contact.phone, localCountry: contact.localCountry,
    contactRevision: revision, identity: contact.identity, suppression: suppression.status, permission });
}

function assertSamePermissionEvent(row: PermissionEventRow, value: ExplicitOccasionPermission): void {
  if (!opaque(row.event_id) || row.patient_id !== String(value.patientId) || row.channel !== value.channel
    || row.endpoint !== value.endpoint || row.purpose !== "occasion" || row.contact_revision !== value.contactRevision
    || row.decision !== value.decision || row.evidence_kind !== value.evidenceKind || row.evidence_id !== value.evidenceId
    || row.source !== value.source || row.source_event_id !== value.sourceEventId || row.occurred_at !== value.occurredAt) {
    throw new Error("occasion_permission_replay_conflict");
  }
}
export async function recordOccasionPermission(input: ExplicitOccasionPermission & { localCountry: LocalPhoneCountry },
  deps: EndpointWriteDeps & ContactProjectionDeps): Promise<{ eventId: string; replayed: boolean }> {
  const value = Object.freeze({ ...input, occurredAt: instant(input.occurredAt) });
  assertPermissionKey(value);
  if (!["granted", "withdrawn"].includes(value.decision)
    || value.evidenceKind !== (value.decision === "granted" ? "explicit_occasion_opt_in" : "explicit_occasion_withdrawal")
    || !opaque(value.evidenceId) || !opaque(value.source) || !opaque(value.sourceEventId, 300)) throw new Error("explicit_occasion_evidence_required");
  return deps.transaction(async executor => {
    await lockMessagingEndpoint(executor, value.channel, value.endpoint);
    const lookup = async () => {
      const result = await executor.query<PermissionEventRow>(`/* messaging:find-permission-event */
        SELECT ${PERMISSION_COLUMNS} FROM occasion_permission_events WHERE source = $1 AND source_event_id = $2`,
      [value.source, value.sourceEventId]);
      if (result.rows.length > 1) throw new Error("invalid_occasion_permission_read");
      return result.rows[0] ?? null;
    };
    const existing = await lookup();
    if (existing) { assertSamePermissionEvent(existing, value); return { eventId: existing.event_id, replayed: true }; }
    const candidate = await readOccasionCandidateOn(executor, { ...value, expectedContactRevision: value.contactRevision }, deps);
    if (!candidate || (value.decision === "granted" && candidate.identity !== "unique")) throw new Error("occasion_contact_not_current_or_unique");
    const eventId = deps.newEventId();
    if (!opaque(eventId)) throw new Error("invalid_occasion_permission_id");
    const inserted = await executor.query<{ event_id: string }>(`/* messaging:append-permission-event */
      INSERT INTO occasion_permission_events
        (event_id, patient_id, channel, endpoint, purpose, contact_revision, decision,
          evidence_kind, evidence_id, source, source_event_id, occurred_at)
      VALUES ($1,$2,$3,$4,'occasion',$5,$6,$7,$8,$9,$10,$11::timestamptz)
      ON CONFLICT (source, source_event_id) DO NOTHING RETURNING event_id`,
    [eventId, value.patientId, value.channel, value.endpoint, value.contactRevision, value.decision,
      value.evidenceKind, value.evidenceId, value.source, value.sourceEventId, value.occurredAt]);
    if (inserted.rows.length === 1 && inserted.rows[0]?.event_id === eventId) return { eventId, replayed: false };
    if (inserted.rows.length !== 0) throw new Error("invalid_occasion_permission_insert");
    const raced = await lookup();
    if (!raced) throw new Error("occasion_permission_insert_unconfirmed");
    assertSamePermissionEvent(raced, value);
    return { eventId: raced.event_id, replayed: true };
  });
}

export interface ServerOwnedOutboundIntent {
  channel: MessagingChannel; endpoint: string;
  /** Derived from the server operation, never a client-provided bypass switch. */
  purpose: string;
  /** Preserve the existing ordinary policy/default exactly. Missing/unknown denies. */
  ordinaryPolicyDecision?: "allow" | "deny" | "unknown";
  /** Mandatory for occasion; caller supplies a fresh authoritative contact read. */
  occasion?: { snapshot: Readonly<RecipientSnapshot>; currentContact: CandidateContact };
}
export type OutboundGuardResult = { allowed: true } | { allowed: false; reason:
  "endpoint_suppressed" | "ordinary_policy_denied" | "occasion_context_missing" | "occasion_contact_changed" | "authorization_scope_closed" };

/**
 * Shared final gate for manual, reply, test, reminder, occasion and future
 * server-owned purposes. Hold this transaction/endpoint lock through provider
 * dispatch. A returned true is not a transferable/long-lived authorization.
 * Exceptions are fail-closed; never catch and then send via an ordinary fallback.
 */
export async function checkServerOwnedOutboundOn(executor: QueryExecutor,
  input: ServerOwnedOutboundIntent): Promise<OutboundGuardResult> {
  const intent: ServerOwnedOutboundIntent = Object.freeze({ channel: input.channel, endpoint: input.endpoint,
    purpose: input.purpose, ordinaryPolicyDecision: input.ordinaryPolicyDecision,
    occasion: input.occasion ? Object.freeze({ snapshot: Object.freeze({ ...input.occasion.snapshot }),
      currentContact: Object.freeze({ ...input.occasion.currentContact, permission: input.occasion.currentContact.permission
        ? Object.freeze({ ...input.occasion.currentContact.permission }) : null }) }) : undefined });
  if (!opaque(intent.purpose, 100)) throw new Error("invalid_server_outbound_purpose");
  if (intent.occasion && intent.purpose !== "occasion") throw new Error("conflicting_server_outbound_purpose");
  await lockMessagingEndpoint(executor, intent.channel, intent.endpoint);
  const suppression = await readEndpointSuppressionOn(executor, intent.channel, intent.endpoint);
  if (suppression.status !== "clear") return { allowed: false, reason: "endpoint_suppressed" };
  if (intent.purpose !== "occasion") return intent.ordinaryPolicyDecision === "allow"
    ? { allowed: true } : { allowed: false, reason: "ordinary_policy_denied" };
  const context = intent.occasion;
  if (!context || !isOccasionChannel(intent.channel) || context.snapshot.channel !== intent.channel
    || context.snapshot.endpoint !== intent.endpoint) return { allowed: false, reason: "occasion_context_missing" };
  const revision = await readActiveContactRevisionOn(executor, context.snapshot.patientId);
  if (!revision || revision !== context.snapshot.contactRevision || context.currentContact.contactRevision !== revision) {
    return { allowed: false, reason: "occasion_contact_changed" };
  }
  const permission = await readOccasionPermissionOn(executor, { patientId: context.snapshot.patientId,
    channel: context.snapshot.channel, endpoint: context.snapshot.endpoint, contactRevision: revision });
  const fresh = { ...context.currentContact, permission, suppression: suppression.status };
  return recheckOccasionRecipient(context.snapshot, fresh).eligible
    ? { allowed: true } : { allowed: false, reason: "occasion_contact_changed" };
}

export interface MessagingConnection extends QueryExecutor {
  /** discard=true MUST destroy the client rather than returning it to a pool. */
  release(discard?: boolean): void | Promise<void>;
}
export interface ServerOwnedOutboundRequest {
  channel: MessagingChannel; endpoint: string; purpose: string;
  occasionSnapshot?: Readonly<RecipientSnapshot>;
}
export interface OutboundDispatchScope {
  /** Revocable facade on the owned client, not the raw pooled connection. */
  executor: QueryExecutor;
  request: Readonly<ServerOwnedOutboundRequest>;
  /**
   * One use, valid only inside dispatch. Rechecks live policy and shared STOP.
   * The provider callback must ALSO validate its exact durable claim/attempt,
   * recipient, template/config binding, current enabled state and readiness.
   */
  authorize(): Promise<boolean>;
}
export type OutboundDispatchScopeResult<T> =
  | { kind: "blocked"; reason: string; cleanupFailed: boolean }
  | { kind: "not_dispatched"; phase: "connection" | "begin" | "guard"; cleanupFailed: boolean }
  | { kind: "dispatched"; observedOutcome: T; cleanupFailed: boolean }
  | { kind: "unconfirmed"; phase: "dispatch" | "dispatch_contract" | "authorization_drain" | "commit";
      observedOutcome?: T; cleanupFailed: boolean };
/** Bounded cleanup only; reaching this deadline destroys rather than reuses the client. */
export const OUTBOUND_AUTHORIZATION_DRAIN_TIMEOUT_MS = 8_000;
export interface OutboundDispatchDeps<T> {
  /** A clean, exclusively leased client with no ambient transaction. */
  connect(): Promise<MessagingConnection>;
  /** Existing ordinary policy, including its existing defaults, with fresh server reads. */
  readOrdinaryPolicyOn(executor: QueryExecutor, request: Readonly<ServerOwnedOutboundRequest>):
    Promise<"allow" | "deny" | "unknown">;
  /** Current full-contact identity projection, read-only and without row locks. */
  readOccasionContactOn?(executor: QueryExecutor, request: Readonly<ServerOwnedOutboundRequest>):
    Promise<CandidateContact | null>;
  /**
   * Exactly one provider attempt against the already-durable immutable claim.
   * Call scope.authorize() in the provider's final authorization callback.
   * Return a data-only provider outcome; do not persist it or lock other rows here.
   */
  dispatch(scope: Readonly<OutboundDispatchScope>): Promise<T>;
}

/**
 * Final network scope, separate from durable claim and outcome transactions.
 * It holds only the endpoint advisory lock through provider I/O. No campaign,
 * recipient, patient or revision row lock is acquired by this wrapper.
 *
 * Nothing here retries. Once dispatch is entered, exceptions cannot establish
 * that no provider I/O occurred. Preserve any observed outcome on COMMIT failure
 * and reconcile it against the original attempt in a SEPARATE transaction.
 */
export async function withServerOwnedOutboundGuard<T>(input: ServerOwnedOutboundRequest,
  deps: OutboundDispatchDeps<T>): Promise<OutboundDispatchScopeResult<T>> {
  const request: Readonly<ServerOwnedOutboundRequest> = Object.freeze({ channel: input.channel,
    endpoint: input.endpoint, purpose: input.purpose,
    occasionSnapshot: input.occasionSnapshot ? Object.freeze({ ...input.occasionSnapshot }) : undefined });
  assertEndpoint(request.channel, request.endpoint);
  if (!opaque(request.purpose, 100)) throw new Error("invalid_server_outbound_purpose");
  if (request.occasionSnapshot && request.purpose !== "occasion") throw new Error("conflicting_server_outbound_purpose");
  let connection: MessagingConnection | null = null;
  let phase: "connection" | "begin" | "guard" | "dispatch" | "dispatch_contract" | "authorization_drain" | "commit" = "connection";
  let dispatchEntered = false;
  let outcomeObserved = false;
  let observedOutcome: T | undefined;
  let scopeActive = false;
  let authorizationUsed = false;
  let authorizationGranted = false;
  let authorizationInFlight: Promise<boolean> | null = null;
  let authorizationPending = false;
  let callbackSqlOpen = false;
  let callbackQueryFailed = false;
  const pendingQueries = new Set<Promise<unknown>>();
  let drainage: Promise<boolean> | null = null;
  let result: OutboundDispatchScopeResult<T>;
  let cleanupFailed = false;
  const closeScopeAndDrain = (): Promise<boolean> => {
    // Revoke BEFORE waiting: suspended callbacks can settle but cannot initiate
    // any more SQL, and late authorize() completion cannot grant permission.
    scopeActive = false;
    callbackSqlOpen = false;
    if (drainage) return drainage;
    const pending = [...pendingQueries];
    if (authorizationPending && authorizationInFlight) pending.push(authorizationInFlight);
    drainage = (async () => {
      if (pending.length === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          Promise.allSettled(pending).then(() => true),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(false), OUTBOUND_AUTHORIZATION_DRAIN_TIMEOUT_MS);
          }),
        ]);
        if (!settled) cleanupFailed = true;
        return settled;
      } catch {
        cleanupFailed = true;
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return drainage;
  };
  try {
    connection = await deps.connect();
    phase = "begin";
    await connection.query("/* messaging:dispatch-begin */ BEGIN ISOLATION LEVEL READ COMMITTED");
    const isolation = await connection.query<{ transaction_isolation: string }>(
      "/* messaging:dispatch-isolation */ SHOW transaction_isolation");
    if (isolation.rows.length !== 1 || isolation.rows[0]?.transaction_isolation !== "read committed") {
      throw new Error("incompatible_dispatch_transaction_isolation");
    }
    phase = "guard";
    await lockMessagingEndpoint(connection, request.channel, request.endpoint);
    const ownedConnection = connection;
    callbackSqlOpen = true;
    // Never hand callbacks a raw reusable client. Track every query admitted
    // before closure, and deny retained-executor work after closure/release.
    const executor: QueryExecutor = Object.freeze({
      query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        if (!callbackSqlOpen) {
          const denied = Promise.reject<{ rows: Row[]; rowCount?: number | null }>(new Error("outbound_query_scope_closed"));
          void denied.catch(() => undefined);
          return denied;
        }
        const pending = (async () => ownedConnection.query<Row>(sql, values))();
        pendingQueries.add(pending);
        // Attach settlement handlers even if a defective adapter drops its
        // promise. Rejection still reaches callers that correctly await it.
        void pending.then(() => { pendingQueries.delete(pending); }, () => {
          pendingQueries.delete(pending);
          callbackQueryFailed = true;
        });
        return pending;
      },
    });
    const closed = (): OutboundGuardResult => ({ allowed: false, reason: "authorization_scope_closed" });
    const readGuard = async (authorizationAttempt = false): Promise<OutboundGuardResult> => {
      if (!callbackSqlOpen || (authorizationAttempt && !scopeActive)) return closed();
      if (request.purpose === "occasion") {
        if (!request.occasionSnapshot || !deps.readOccasionContactOn) return { allowed: false, reason: "occasion_context_missing" };
        const currentContact = await deps.readOccasionContactOn(executor, request);
        if (!callbackSqlOpen || (authorizationAttempt && !scopeActive)) return closed();
        if (!currentContact) return { allowed: false, reason: "occasion_contact_changed" };
        return checkServerOwnedOutboundOn(executor, { channel: request.channel, endpoint: request.endpoint,
          purpose: request.purpose, occasion: { snapshot: request.occasionSnapshot, currentContact } });
      }
      const ordinaryPolicyDecision = await deps.readOrdinaryPolicyOn(executor, request);
      if (!callbackSqlOpen || (authorizationAttempt && !scopeActive)) return closed();
      return checkServerOwnedOutboundOn(executor, { channel: request.channel, endpoint: request.endpoint,
        purpose: request.purpose, ordinaryPolicyDecision });
    };
    const initial = await readGuard();
    if (!initial.allowed) {
      if (!(await closeScopeAndDrain())) throw new Error("outbound_scope_drain_unconfirmed");
      await connection.query("/* messaging:dispatch-rollback */ ROLLBACK");
      result = { kind: "blocked", reason: initial.reason, cleanupFailed: false };
    } else {
      phase = "dispatch";
      scopeActive = true;
      const scope: Readonly<OutboundDispatchScope> = Object.freeze({ executor, request, authorize: () => {
        if (!scopeActive || authorizationUsed) return Promise.resolve(false);
        authorizationUsed = true;
        authorizationPending = true;
        authorizationInFlight = (async () => {
          try {
            const current = await readGuard(true);
            authorizationGranted = scopeActive && current.allowed;
            return authorizationGranted;
          } catch {
            // A dropped void authorize() must not leave an unhandled rejection
            // or escape cleanup ownership. The failed check never grants.
            return false;
          } finally {
            authorizationPending = false;
          }
        })();
        return authorizationInFlight;
      } });
      dispatchEntered = true;
      // Snapshot immediately, before COMMIT can await and allow the source object
      // returned by an adapter to mutate. Provider results must be data-only.
      const returnedOutcome = await deps.dispatch(scope);
      scopeActive = false;
      callbackSqlOpen = false;
      observedOutcome = structuredClone(returnedOutcome);
      outcomeObserved = true;
      if (!(await closeScopeAndDrain())) {
        phase = "authorization_drain";
        throw new Error("outbound_scope_drain_unconfirmed");
      }
      if (!authorizationGranted || callbackQueryFailed) {
        phase = "dispatch_contract";
        throw new Error("provider_did_not_use_in_scope_authorization");
      }
      phase = "commit";
      await connection.query("/* messaging:dispatch-commit */ COMMIT");
      result = { kind: "dispatched", observedOutcome, cleanupFailed: false };
    }
  } catch {
    const drained = await closeScopeAndDrain();
    if (!drained && dispatchEntered) phase = "authorization_drain";
    result = dispatchEntered
      ? { kind: "unconfirmed", phase: phase === "commit" ? "commit"
        : phase === "authorization_drain" ? "authorization_drain"
          : phase === "dispatch_contract" ? "dispatch_contract" : "dispatch",
        ...(outcomeObserved ? { observedOutcome: observedOutcome as T } : {}), cleanupFailed: false }
      : { kind: "not_dispatched", phase: phase === "connection" ? "connection" : phase === "begin" ? "begin" : "guard",
        cleanupFailed: false };
    // Do not queue rollback behind unresolved callback SQL. A failed drain
    // forces physical client destruction below, never ordinary pool release.
    if (connection && drained) {
      try { await connection.query("/* messaging:dispatch-rollback */ ROLLBACK"); }
      catch { cleanupFailed = true; }
    }
  } finally {
    await closeScopeAndDrain();
    if (connection) {
      try { await connection.release(cleanupFailed); }
      catch { cleanupFailed = true; }
    }
  }
  return { ...result, cleanupFailed };
}
