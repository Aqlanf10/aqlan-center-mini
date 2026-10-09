/**
 * Source-authored only; NOT executed. Exercises the actual dispatch bridge and
 * shared guard/provider implementations using only injected synthetic adapters.
 * This sequential query fake does not establish real PostgreSQL concurrency.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../lib/messaging-channels";
import { claimRecipient, evaluateOccasionRecipient, queuedRecipient, type CandidateContact } from "../lib/occasion-campaign-core";
import type { CampaignBatchLease, CampaignClaim } from "../lib/occasion-campaign-runner";
import { dispatchClaimedOccasion, type OccasionDispatchDeps } from "../lib/occasion-campaign-dispatch";
import type { MessagingConnection, QueryExecutor } from "../lib/messaging-suppression";
import { verifyOccasionTemplate, type OccasionProviderChannel } from "../lib/whatsapp-occasion-provider";

const NOW = 1_800_000_000_000;
const ENDPOINT = "967770123456";
const RECEIPT = "wamid.synthetic-original-receipt";
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
type FixtureOptions = {
  stopped?: boolean;
  dispatchAllowed?: boolean;
  failCommit?: boolean;
  failRelease?: boolean;
  providerFailure?: "transport" | "http_503";
};

async function fixture(options: FixtureOptions = {}) {
  const channel: OccasionProviderChannel = {
    enabled: true, revision: "synthetic-channel-v1", secret: "synthetic-no-real-token",
    config: { ...DEFAULT_CONFIG.whatsapp, phoneNumberId: "12345678", businessAccountId: "87654321" },
  };
  const rawTemplate = { id: "synthetic-template-1", name: "owner_chosen_greeting", language: "ar",
    status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "كل عام وأنتم بخير." }] };
  // Verification is also injected and synthetic; no globally available fetch is used.
  const verificationTransport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "GET") throw new Error("unexpected_verification_method");
    if (String(url).includes("/phone_numbers?")) return json({ data: [{ id: channel.config.phoneNumberId }] });
    if (String(url).includes("/message_templates?")) return json({ data: [rawTemplate] });
    throw new Error("unexpected_synthetic_verification_url");
  });
  const verified = await verifyOccasionTemplate({ channel, name: rawTemplate.name, language: rawTemplate.language }, {
    nowMs: () => NOW, fetchImpl: verificationTransport as typeof fetch,
  });
  if (!verified.ok) throw new Error(`invalid_synthetic_template:${verified.reason}`);

  const currentContact: CandidateContact = { patientId: 1, phone: `+${ENDPOINT}`, localCountry: null,
    contactRevision: "synthetic-contact-v1", identity: "unique", suppression: "clear",
    permission: { eventId: "synthetic-grant-1", patientId: 1, channel: "whatsapp", purpose: "occasion",
      endpoint: ENDPOINT, contactRevision: "synthetic-contact-v1", decision: "granted", evidenceId: "synthetic-grant-evidence" } };
  const eligibility = evaluateOccasionRecipient(currentContact, "whatsapp");
  if (!eligibility.eligible) throw new Error("invalid_synthetic_contact");
  const lease: CampaignBatchLease = { campaignId: "synthetic-campaign-1", authorizationId: "synthetic-approval-1",
    leaseId: "synthetic-lease-1", gate: { featureEnabled: true, channel, template: verified.template,
      approvedContentDigest: verified.template.contentDigest, reviewedGenericOccasion: true } };
  const claim: CampaignClaim = { campaignId: lease.campaignId, authorizationId: lease.authorizationId,
    recipientId: 101, snapshot: eligibility.recipient, currentContact,
    state: claimRecipient(queuedRecipient(), { campaignActive: true, snapshot: eligibility.recipient,
      currentContact, attemptId: "synthetic-attempt-1" }) };

  const events: string[] = [];
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  let transactionActive = false;
  let endpointLocked = false;
  const query: QueryExecutor["query"] = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values: readonly unknown[] = [],
  ) => {
    queries.push({ sql, values: [...values] });
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("messaging:dispatch-begin")) {
      if (transactionActive || !sql.includes("BEGIN ISOLATION LEVEL READ COMMITTED")) throw new Error("invalid_synthetic_begin");
      transactionActive = true;
      events.push("begin");
    } else {
      if (!transactionActive) throw new Error("query_outside_owned_transaction");
      if (sql.includes("messaging:dispatch-isolation")) {
        rows = [{ transaction_isolation: "read committed" }];
      } else if (sql.includes("messaging:endpoint-lock")) {
        if (values[0] !== "whatsapp" || values[1] !== ENDPOINT) throw new Error("wrong_endpoint_lock");
        endpointLocked = true;
        events.push("endpoint-lock");
      } else if (sql.includes("messaging:read-suppression")) {
        if (!endpointLocked || values[0] !== "whatsapp" || values[1] !== ENDPOINT) throw new Error("unguarded_suppression_read");
        rows = [{ stop_id: options.stopped ? "synthetic-stop-1" : null, clear_id: null }];
      } else if (sql.includes("messaging:read-contact-revision")) {
        if (!endpointLocked || values[0] !== 1) throw new Error("wrong_contact_revision_read");
        rows = [{ contact_revision: "synthetic-contact-v1", active: true }];
      } else if (sql.includes("messaging:read-occasion-permission")) {
        if (!endpointLocked || values[0] !== 1 || values[1] !== "whatsapp" || values[2] !== ENDPOINT
          || values[3] !== "synthetic-contact-v1") throw new Error("wrong_permission_scope");
        rows = [{ event_id: "synthetic-grant-1", patient_id: "1", channel: "whatsapp", endpoint: ENDPOINT,
          purpose: "occasion", contact_revision: "synthetic-contact-v1", decision: "granted",
          evidence_kind: "explicit_occasion_opt_in", evidence_id: "synthetic-grant-evidence",
          source: "synthetic-consent-desk", source_event_id: "synthetic-grant-source-1", occurred_at: "2026-10-08T12:00:00.000Z" }];
      } else if (sql.includes("messaging:dispatch-commit")) {
        events.push("commit");
        if (options.failCommit) throw new Error("synthetic_commit_unconfirmed");
        transactionActive = false;
        endpointLocked = false;
      } else if (sql.includes("messaging:dispatch-rollback")) {
        events.push("rollback");
        transactionActive = false;
        endpointLocked = false;
      } else throw new Error("unexpected_synthetic_sql");
    }
    return { rows: structuredClone(rows) as Row[], rowCount: rows.length };
  };
  const release = vi.fn(async (_discard?: boolean) => {
    events.push("release");
    if (transactionActive) throw new Error("releasing_active_transaction");
    if (options.failRelease) throw new Error("synthetic_release_failure");
  });
  const connection: MessagingConnection = { query, release };
  let scopedExecutor: QueryExecutor | null = null;
  const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    events.push("provider-post");
    if (!transactionActive || !endpointLocked) throw new Error("provider_io_without_endpoint_lock");
    if (init?.method !== "POST" || String(url) !== "https://graph.facebook.com/v21.0/12345678/messages") {
      throw new Error("unexpected_synthetic_dispatch_request");
    }
    if (options.providerFailure === "transport") throw new Error("synthetic_network_failure");
    if (options.providerFailure === "http_503") return json({ error: { code: 1 } }, 503);
    return json({ messaging_product: "whatsapp", contacts: [{ input: ENDPOINT, wa_id: ENDPOINT }], messages: [{ id: RECEIPT }] });
  });
  const deps: OccasionDispatchDeps = {
    connect: vi.fn(async () => connection),
    fetchImpl: transport as typeof fetch,
    nowMs: () => NOW,
    readContactOn: vi.fn(async (executor, boundClaim) => {
      if (!transactionActive || !endpointLocked) throw new Error("contact_read_outside_endpoint_scope");
      if (scopedExecutor === null) scopedExecutor = executor;
      if (executor !== scopedExecutor) throw new Error("changed_scoped_executor");
      if (boundClaim.state.attemptId !== "synthetic-attempt-1" || boundClaim.recipientId !== 101) throw new Error("changed_claim_binding");
      return structuredClone(currentContact);
    }),
    canDispatchOn: vi.fn(async (executor, boundLease, boundClaim) => {
      events.push("current-can-dispatch");
      if (executor !== scopedExecutor || !transactionActive || !endpointLocked) throw new Error("dispatch_gate_outside_endpoint_scope");
      if (!Object.isFrozen(boundLease) || !Object.isFrozen(boundClaim)
        || boundLease.leaseId !== "synthetic-lease-1" || boundClaim.state.attemptId !== "synthetic-attempt-1") {
        throw new Error("unbound_dispatch_claim");
      }
      return options.dispatchAllowed !== false;
    }),
  };
  return { lease, claim, deps, connection, transport, release, queries, events };
}

describe("actual occasion dispatch bridge", () => {
  it("refuses durable endpoint STOP without POST, even when the claim's older contact says clear", async () => {
    const f = await fixture({ stopped: true });
    expect(f.claim.currentContact.suppression).toBe("clear");
    expect(await dispatchClaimedOccasion(f.lease, f.claim, f.deps)).toEqual({
      outcome: { kind: "not_accepted", retryable: false }, reason: "recipient_not_authorized", stopCampaign: false,
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.deps.canDispatchOn).not.toHaveBeenCalled();
    expect(f.events).toContain("rollback");
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("accepts one valid immutable claim and performs POST while the endpoint transaction remains held", async () => {
    const f = await fixture();
    expect(await dispatchClaimedOccasion(f.lease, f.claim, f.deps)).toEqual({
      outcome: { kind: "accepted", providerMessageId: RECEIPT }, reason: "accepted", stopCampaign: false,
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.deps.canDispatchOn).toHaveBeenCalledTimes(1);
    expect(f.deps.connect).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf("endpoint-lock")).toBeLessThan(f.events.indexOf("provider-post"));
    expect(f.events.indexOf("current-can-dispatch")).toBeLessThan(f.events.indexOf("provider-post"));
    expect(f.events.indexOf("provider-post")).toBeLessThan(f.events.indexOf("commit"));
    expect(f.events.indexOf("commit")).toBeLessThan(f.events.indexOf("release"));
    expect(f.queries.every(call => !/FOR UPDATE|FOR SHARE|INSERT INTO|UPDATE occasion_campaign/i.test(call.sql))).toBe(true);
    const body = JSON.parse(String(f.transport.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: ENDPOINT, type: "template",
      template: { name: "owner_chosen_greeting", language: { code: "ar" } } });
    expect(f.claim.state.attemptId).toBe("synthetic-attempt-1");
  });

  it("rechecks current campaign/lease/config authorization and refuses canDispatch=false without POST", async () => {
    const f = await fixture({ dispatchAllowed: false });
    expect(await dispatchClaimedOccasion(f.lease, f.claim, f.deps)).toEqual({
      outcome: { kind: "not_accepted", retryable: false }, reason: "binding_changed", stopCampaign: true,
    });
    expect(f.deps.canDispatchOn).toHaveBeenCalledTimes(1);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["commit", "release"] as const)("retains the original acceptance receipt and pauses on post-provider %s failure", async failure => {
    const f = await fixture({ failCommit: failure === "commit", failRelease: failure === "release" });
    expect(await dispatchClaimedOccasion(f.lease, f.claim, f.deps)).toEqual({
      outcome: { kind: "accepted", providerMessageId: RECEIPT }, reason: "accepted", stopCampaign: true,
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.deps.connect).toHaveBeenCalledTimes(1);
    expect(f.deps.canDispatchOn).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.events.filter(event => event === "provider-post")).toHaveLength(1);
    expect(f.events.indexOf("provider-post")).toBeLessThan(f.events.indexOf("commit"));
    if (failure === "commit") expect(f.events).toContain("rollback");
    else expect(f.events).not.toContain("rollback");
  });

  it.each(["transport", "http_503"] as const)("keeps %s provider uncertainty non-retryable and performs no automatic second attempt", async providerFailure => {
    const f = await fixture({ providerFailure });
    expect(await dispatchClaimedOccasion(f.lease, f.claim, f.deps)).toEqual({
      outcome: { kind: "unknown" }, reason: "ambiguous_response", stopCampaign: true,
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.deps.connect).toHaveBeenCalledTimes(1);
    expect(f.deps.canDispatchOn).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
