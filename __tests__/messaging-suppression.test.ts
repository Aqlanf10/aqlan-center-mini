/** Authored only, NOT executed. This fake proves helper decisions, not PostgreSQL concurrency/DDL. */
import { describe, expect, it, vi } from "vitest";
import { OCCASION_CONTACT_SCHEMA_SQL } from "../lib/occasion-contact-schema";
import { canonicalMessagingEndpoint, checkServerOwnedOutboundOn, ingestEndpointStop,
  lockMessagingEndpoint, readEndpointSuppressionOn, readOccasionCandidateOn,
  readOccasionPermissionOn, recordAuthenticatedEndpointStop, recordContactRevisionOn,
  recordExplicitEndpointResubscription, recordOccasionPermission, withServerOwnedOutboundGuard,
  OUTBOUND_AUTHORIZATION_DRAIN_TIMEOUT_MS,
  type AuthenticatedEndpointSignal, type ContactProjectionDeps, type ExplicitOccasionPermission,
  type MessagingConnection, type OutboundDispatchDeps, type OutboundDispatchScope,
  type QueryExecutor, type StopWriteDeps } from "../lib/messaging-suppression";
import type { CandidateContact, RecipientSnapshot } from "../lib/occasion-campaign-core";

const ENDPOINT = "967770123456";
const SAME_SUFFIX_OTHER_COUNTRY = "966770123456";
const TIME = "2026-10-08T12:00:00.000Z";
type Row = Record<string, unknown>;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function signal(id = "stop-1", endpoint = ENDPOINT): AuthenticatedEndpointSignal {
  return { channel: "whatsapp", endpoint, source: "synthetic-provider:account-1", sourceEventId: id,
    evidenceId: `evidence-${id}`, authenticationEvidenceId: `authentication-${id}`, occurredAt: TIME };
}
function grant(overrides: Partial<ExplicitOccasionPermission> = {}) {
  return { patientId: 1, channel: "whatsapp" as const, endpoint: ENDPOINT, contactRevision: "contact-1",
    decision: "granted" as const, evidenceKind: "explicit_occasion_opt_in" as const,
    evidenceId: "grant-evidence-1", source: "synthetic-consent-desk", sourceEventId: "grant-1",
    occurredAt: TIME, localCountry: null, ...overrides };
}

/** A deliberately sequential fake. It cannot certify advisory locks or isolation. */
function fixture() {
  const state = { endpointEvents: [] as Row[], permissionEvents: [] as Row[], revisionEvents: [{
    contact_revision: "contact-1", patient_id: 1, previous_contact_revision: null,
    reason: "initialize", active: true, evidence_id: "synthetic-initial-contact-evidence",
  }] as Row[],
    revisions: new Map<number, { contact_revision: string; active: boolean }>([[1, { contact_revision: "contact-1", active: true }]]) };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let sequence = 0;
  let commitFails = false;
  let queryFailure: string | null = null;
  const executor: QueryExecutor = {
    async query<T extends Row = Row>(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values: [...values] });
      if (queryFailure && sql.includes(queryFailure)) throw new Error("synthetic_query_failure");
      let rows: Row[] = [];
      if (sql.includes("messaging:dispatch-isolation")) {
        rows = [{ transaction_isolation: "read committed" }];
      } else if (sql.includes("messaging:dispatch-begin") || sql.includes("messaging:dispatch-commit")
        || sql.includes("messaging:dispatch-rollback")) {
        rows = [];
      } else if (sql.includes("messaging:endpoint-lock") || sql.includes("messaging:contact-revision-lock")) {
        rows = [];
      } else if (sql.includes("messaging:read-suppression")) {
        const stops = state.endpointEvents.filter(e => e.channel === values[0] && e.endpoint === values[1] && e.kind === "stop");
        const stop = stops.at(-1);
        const clear = stop ? state.endpointEvents.filter(e => e.channel === values[0] && e.endpoint === values[1]
          && e.kind === "resubscribe" && e.target_stop_event_id === stop.event_id).at(-1) : null;
        rows = [{ stop_id: stop?.event_id ?? null, clear_id: clear?.event_id ?? null }];
      } else if (sql.includes("messaging:find-endpoint-event")) {
        rows = state.endpointEvents.filter(e => e.source === values[0] && e.source_event_id === values[1]);
      } else if (sql.includes("messaging:append-endpoint-event")) {
        if (state.endpointEvents.some(e => e.event_id === values[0])) throw new Error("synthetic_duplicate_id");
        if (!state.endpointEvents.some(e => e.source === values[5] && e.source_event_id === values[6])) {
          state.endpointEvents.push({ event_id: values[0], channel: values[1], endpoint: values[2], kind: values[3],
            target_stop_event_id: values[4], source: values[5], source_event_id: values[6], evidence_id: values[7],
            authentication_evidence_id: values[8], occurred_at: values[9] });
          rows = [{ event_id: values[0] }];
        }
      } else if (sql.includes("messaging:read-contact-revision") || sql.includes("messaging:lock-contact-revision")) {
        const row = state.revisions.get(Number(values[0]));
        rows = row ? [{ ...row }] : [];
      } else if (sql.includes("messaging:append-contact-revision")) {
        if (state.revisionEvents.some(e => e.contact_revision === values[0])) throw new Error("synthetic_revision_reuse");
        state.revisionEvents.push({ contact_revision: values[0], patient_id: values[1], previous_contact_revision: values[2],
          reason: values[3], active: values[4], evidence_id: values[5] });
        rows = [{ contact_revision: values[0] }];
      } else if (sql.includes("messaging:advance-contact-revision")) {
        const event = state.revisionEvents.find(e => e.contact_revision === values[1])!;
        state.revisions.set(Number(values[0]), { contact_revision: String(values[1]), active: event.active === true });
        rows = [{ contact_revision: values[1] }];
      } else if (sql.includes("messaging:find-permission-event")) {
        rows = state.permissionEvents.filter(e => e.source === values[0] && e.source_event_id === values[1]);
      } else if (sql.includes("messaging:read-occasion-permission")) {
        const row = state.permissionEvents.filter(e => e.patient_id === String(values[0]) && e.channel === values[1]
          && e.endpoint === values[2] && e.contact_revision === values[3] && e.purpose === "occasion").at(-1);
        rows = row ? [row] : [];
      } else if (sql.includes("messaging:append-permission-event")) {
        if (!state.permissionEvents.some(e => e.source === values[8] && e.source_event_id === values[9])) {
          state.permissionEvents.push({ event_id: values[0], patient_id: String(values[1]), channel: values[2], endpoint: values[3],
            purpose: "occasion", contact_revision: values[4], decision: values[5], evidence_kind: values[6], evidence_id: values[7],
            source: values[8], source_event_id: values[9], occurred_at: values[10] });
          rows = [{ event_id: values[0] }];
        }
      } else throw new Error("unexpected_synthetic_query");
      return { rows: structuredClone(rows) as T[], rowCount: rows.length };
    },
  };
  const deps: StopWriteDeps & ContactProjectionDeps = {
    newEventId: () => `event-${++sequence}`,
    transaction: async work => {
      const before = structuredClone(state);
      try {
        const result = await work(executor);
        if (commitFails) throw new Error("synthetic_commit_failure");
        return result;
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
    suppressQueuedOn: vi.fn(async () => undefined),
    readPatientContactProjectionOn: vi.fn(async (_executor, input) => {
      const revision = state.revisions.get(input.patientId);
      return revision?.active ? { patientId: input.patientId, phone: `+${input.endpoint}`, localCountry: input.localCountry,
        contactRevision: revision.contact_revision, identity: "unique" as const } : null;
    }),
  };
  return { executor, deps, state, calls, failCommit: () => { commitFails = true; },
    failQuery: (tag: string) => { queryFailure = tag; } };
}

describe("durable endpoint STOP source contract", () => {
  it("keeps full destination and channel separate, including equal last-nine digits", async () => {
    const f = fixture();
    await recordAuthenticatedEndpointStop(signal(), f.deps);
    expect(await readEndpointSuppressionOn(f.executor, "whatsapp", ENDPOINT)).toMatchObject({ status: "suppressed" });
    expect(await readEndpointSuppressionOn(f.executor, "whatsapp", SAME_SUFFIX_OTHER_COUNTRY)).toMatchObject({ status: "clear" });
    expect(await readEndpointSuppressionOn(f.executor, "sms", ENDPOINT)).toMatchObject({ status: "clear" });
  });

  it("canonicalizes the entire email address consistently with existing app matching", async () => {
    const f = fixture();
    const canonical = canonicalMessagingEndpoint("email", "  Patient@EXAMPLE.COM  ")!;
    expect(canonical).toBe("patient@example.com");
    await recordAuthenticatedEndpointStop({ ...signal(), channel: "email", endpoint: canonical }, f.deps);
    expect(await checkServerOwnedOutboundOn(f.executor, { channel: "email", endpoint: canonical,
      purpose: "reply", ordinaryPolicyDecision: "allow" })).toEqual({ allowed: false, reason: "endpoint_suppressed" });
    await expect(lockMessagingEndpoint(f.executor, "email", "Patient@example.com")).rejects.toThrow("invalid_canonical");
    expect(canonicalMessagingEndpoint("email", "Name <patient@example.com>")).toBeNull();
    expect(canonicalMessagingEndpoint("email", "first@example.com,second@example.com")).toBeNull();
  });

  it("resolves local phones only with trusted country context", async () => {
    const f = fixture();
    expect(canonicalMessagingEndpoint("whatsapp", "770123456")).toBeNull();
    expect(canonicalMessagingEndpoint("whatsapp", "770123456", "YE")).toBe(ENDPOINT);
    expect(canonicalMessagingEndpoint("whatsapp", `+${SAME_SUFFIX_OTHER_COUNTRY}`, "YE")).toBe(SAME_SUFFIX_OTHER_COUNTRY);
    // Full E.164-shaped input is required by the boundary; a bare local phone
    // must never be passed as if it were an international DB endpoint.
    await expect(lockMessagingEndpoint(f.executor, "whatsapp", "+967770123456")).rejects.toThrow("invalid_canonical");
  });

  it("uses one transaction-scoped advisory namespace for every caller", async () => {
    const f = fixture();
    await lockMessagingEndpoint(f.executor, "whatsapp", ENDPOINT);
    expect(f.calls[0].sql).toContain("pg_advisory_xact_lock");
    expect(f.calls[0].sql).toContain("messaging:endpoint:v1:");
    expect(f.calls[0].values).toEqual(["whatsapp", ENDPOINT]);
  });

  it("replayed old STOP cannot undo explicit later resubscription or suppress new queued rows", async () => {
    const f = fixture();
    const stopped = await recordAuthenticatedEndpointStop(signal(), f.deps);
    const subscribed = await recordExplicitEndpointResubscription({ ...signal("resubscribe-1"),
      explicitResubscription: true, targetStopEventId: stopped.eventId }, f.deps);
    expect(subscribed.suppression.status).toBe("clear");
    const replay = await recordAuthenticatedEndpointStop(signal(), f.deps);
    expect(replay).toMatchObject({ eventId: stopped.eventId, replayed: true, suppression: { status: "clear" } });
    expect(f.state.endpointEvents).toHaveLength(2);
    expect(f.deps.suppressQueuedOn).toHaveBeenCalledTimes(1);
  });

  it("new STOP revokes clear state; a replayed older resubscription cannot clear the new STOP", async () => {
    const f = fixture();
    const first = await recordAuthenticatedEndpointStop(signal(), f.deps);
    const resubscribe = { ...signal("resubscribe-1"), explicitResubscription: true as const, targetStopEventId: first.eventId };
    await recordExplicitEndpointResubscription(resubscribe, f.deps);
    const latest = await recordAuthenticatedEndpointStop(signal("stop-2"), f.deps);
    expect((await recordExplicitEndpointResubscription(resubscribe, f.deps)).suppression).toMatchObject({
      status: "suppressed", latestStopEventId: latest.eventId,
    });
    await expect(recordExplicitEndpointResubscription({ ...signal("resubscribe-wrong"),
      explicitResubscription: true, targetStopEventId: first.eventId }, f.deps)).rejects.toThrow("latest_active_stop");
    expect(f.state.endpointEvents).toHaveLength(3);
  });

  it("requires explicit stable evidence and refuses a provider-key content collision", async () => {
    const f = fixture();
    const stop = await recordAuthenticatedEndpointStop(signal(), f.deps);
    await expect(recordExplicitEndpointResubscription({ ...signal("resubscribe-1"), targetStopEventId: stop.eventId,
      explicitResubscription: false } as never, f.deps)).rejects.toThrow("explicit_resubscription_required");
    await expect(recordAuthenticatedEndpointStop({ ...signal(), endpoint: SAME_SUFFIX_OTHER_COUNTRY }, f.deps))
      .rejects.toThrow("endpoint_event_replay_conflict");
    expect(f.state.endpointEvents).toHaveLength(1);
  });

  it.each(["append", "queue", "commit"] as const)("never acknowledges authenticated STOP when %s persistence fails, even disabled", async mode => {
    const f = fixture();
    if (mode === "append") f.failQuery("messaging:append-endpoint-event");
    if (mode === "queue") f.deps.suppressQueuedOn = vi.fn(async () => { throw new Error("synthetic_queue_failure"); });
    if (mode === "commit") f.failCommit();
    const deps = { ...f.deps, outgoingEnabled: false, authenticateStop: vi.fn(async () => signal()) };
    expect(await ingestEndpointStop({ synthetic: true }, deps)).toEqual({ status: 503 });
    expect(deps.authenticateStop).toHaveBeenCalledTimes(1);
    expect(f.state.endpointEvents).toHaveLength(0);
  });

  it("does not consult outgoing enablement when receiving authenticated STOP", async () => {
    const f = fixture();
    const deps = { ...f.deps, authenticateStop: vi.fn(async () => signal()),
      get outgoingEnabled(): boolean { throw new Error("outgoing_gate_must_not_be_consulted"); } };
    expect(await ingestEndpointStop({}, deps)).toEqual({ status: 200 });
    expect(f.state.endpointEvents).toHaveLength(1);
    expect(await ingestEndpointStop({}, { ...f.deps, authenticateStop: async () => null })).toEqual({ status: 403 });
  });

  it("captures authenticated signal before asynchronous mutation", async () => {
    const f = fixture();
    const original = signal();
    const transaction = f.deps.transaction;
    f.deps.transaction = async work => {
      original.endpoint = SAME_SUFFIX_OTHER_COUNTRY;
      original.sourceEventId = "mutated-provider-event";
      return transaction(work);
    };
    await recordAuthenticatedEndpointStop(original, f.deps);
    expect(f.state.endpointEvents[0]).toMatchObject({ endpoint: ENDPOINT, source_event_id: "stop-1" });
  });

  it("fails closed on missing schema/read errors or malformed suppression result", async () => {
    const f = fixture();
    f.failQuery("messaging:read-suppression");
    await expect(checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT,
      purpose: "test", ordinaryPolicyDecision: "allow" })).rejects.toThrow("synthetic_query_failure");
    const malformed: QueryExecutor = { query: async () => ({ rows: [] }) };
    await expect(readEndpointSuppressionOn(malformed, "whatsapp", ENDPOINT)).rejects.toThrow("invalid_suppression_read");
  });
});

describe("endpoint-only network authorization scope", () => {
  const request = { channel: "whatsapp" as const, endpoint: ENDPOINT, purpose: "manual" };
  type Outcome = { kind: string; providerMessageId: string | null };
  function networkFixture() {
    const f = fixture();
    let released = false;
    const releasedQueryAttempts: string[] = [];
    const release = vi.fn(async (_discard?: boolean) => { released = true; });
    const connection: MessagingConnection = { query: async <T extends Row = Row>(sql: string, values?: readonly unknown[]) => {
      if (released) {
        releasedQueryAttempts.push(sql);
        throw new Error("synthetic_query_on_released_client");
      }
      return f.executor.query<T>(sql, values);
    }, release };
    const deps: OutboundDispatchDeps<Outcome> = {
      connect: vi.fn(async () => connection),
      readOrdinaryPolicyOn: vi.fn(async () => "allow" as const),
      dispatch: vi.fn(async scope => {
        if (!(await scope.authorize())) return { kind: "not_sent", providerMessageId: null };
        return { kind: "accepted", providerMessageId: "synthetic-receipt" };
      }),
    };
    return { ...f, connection, release, network: deps, releasedQueryAttempts };
  }

  it("owns READ COMMITTED, keeps authorization scoped/one-use, and releases before outcome persistence", async () => {
    const f = networkFixture();
    let captured: Readonly<OutboundDispatchScope> | null = null;
    let dispatchCallIndex = -1;
    f.network.dispatch = vi.fn(async scope => {
      captured = scope;
      expect(await scope.authorize()).toBe(true);
      expect(await scope.authorize()).toBe(false);
      dispatchCallIndex = f.calls.length;
      expect(f.calls.some(call => call.sql.includes("dispatch-commit"))).toBe(false);
      return { kind: "accepted", providerMessageId: "synthetic-receipt" };
    });
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "dispatched",
      observedOutcome: { kind: "accepted", providerMessageId: "synthetic-receipt" }, cleanupFailed: false });
    expect(f.calls[0].sql).toContain("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.calls.findIndex(call => call.sql.includes("dispatch-commit"))).toBeGreaterThanOrEqual(dispatchCallIndex);
    expect(f.calls.every(call => !/FOR UPDATE|FOR SHARE|UPDATE occasion_campaign|INSERT INTO/i.test(call.sql))).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(await (captured as unknown as OutboundDispatchScope).authorize()).toBe(false);
  });

  it("never enters dispatch when STOP is already durable", async () => {
    const f = networkFixture();
    await recordAuthenticatedEndpointStop(signal(), f.deps);
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "blocked",
      reason: "endpoint_suppressed", cleanupFailed: false });
    expect(f.network.dispatch).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a connection exposing incompatible transaction isolation", async () => {
    const f = networkFixture();
    const original = f.connection.query;
    f.connection.query = async <T extends Row = Row>(sql: string, values?: readonly unknown[]) =>
      sql.includes("dispatch-isolation")
        ? { rows: [{ transaction_isolation: "repeatable read" }] as unknown as T[] }
        : original<T>(sql, values);
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "not_dispatched", phase: "begin", cleanupFailed: false });
    expect(f.network.dispatch).not.toHaveBeenCalled();
  });

  it("preserves observed provider receipt on post-network COMMIT failure and never retries", async () => {
    const f = networkFixture();
    f.failQuery("dispatch-commit");
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "unconfirmed", phase: "commit",
      observedOutcome: { kind: "accepted", providerMessageId: "synthetic-receipt" }, cleanupFailed: false });
    expect(f.network.dispatch).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("captures the exact outcome before asynchronous COMMIT permits adapter mutation", async () => {
    const f = networkFixture();
    const observation: Outcome = { kind: "accepted", providerMessageId: "original-receipt" };
    f.network.dispatch = vi.fn(async scope => { await scope.authorize(); return observation; });
    const original = f.connection.query;
    f.connection.query = async <T extends Row = Row>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes("dispatch-commit")) observation.providerMessageId = "mutated-receipt";
      return original<T>(sql, values);
    };
    expect(await withServerOwnedOutboundGuard(request, f.network)).toMatchObject({ kind: "dispatched",
      observedOutcome: { providerMessageId: "original-receipt" } });
  });

  it("makes a dispatch exception uncertain rather than eligible for resend", async () => {
    const f = networkFixture();
    f.network.dispatch = vi.fn(async scope => { await scope.authorize(); throw new Error("synthetic_network_failure"); });
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "unconfirmed", phase: "dispatch", cleanupFailed: false });
    expect(f.network.dispatch).toHaveBeenCalledTimes(1);
  });

  it("flags an adapter that ignored the in-scope authorization callback", async () => {
    const f = networkFixture();
    f.network.dispatch = vi.fn(async () => ({ kind: "accepted", providerMessageId: "adapter-bypass-receipt" }));
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "unconfirmed", phase: "dispatch_contract",
      observedOutcome: { kind: "accepted", providerMessageId: "adapter-bypass-receipt" }, cleanupFailed: false });
  });

  it("reports connection cleanup failure without discarding a captured receipt", async () => {
    const f = networkFixture();
    f.connection.release = vi.fn(async () => { throw new Error("synthetic_release_failure"); });
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "dispatched",
      observedOutcome: { kind: "accepted", providerMessageId: "synthetic-receipt" }, cleanupFailed: true });
  });

  it("requires discarding a connection when rollback cannot be confirmed", async () => {
    const f = networkFixture();
    f.failQuery("dispatch-rollback");
    f.network.dispatch = vi.fn(async scope => { await scope.authorize(); throw new Error("synthetic_network_failure"); });
    expect(await withServerOwnedOutboundGuard(request, f.network)).toEqual({ kind: "unconfirmed", phase: "dispatch", cleanupFailed: true });
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("permits initial guard callback SQL before activation and revokes its retained executor on completion", async () => {
    const f = networkFixture();
    let retained: QueryExecutor | null = null;
    f.network.readOrdinaryPolicyOn = vi.fn(async (executor: QueryExecutor) => {
      retained = executor;
      expect(executor).not.toBe(f.connection);
      expect((await readEndpointSuppressionOn(executor, "whatsapp", ENDPOINT)).status).toBe("clear");
      return "allow" as const;
    });
    expect(await withServerOwnedOutboundGuard(request, f.network)).toMatchObject({ kind: "dispatched" });
    const count = f.calls.length;
    await expect((retained as unknown as QueryExecutor).query("SELECT 'late'"))
      .rejects.toThrow("outbound_query_scope_closed");
    expect(f.calls).toHaveLength(count);
    expect(f.releasedQueryAttempts).toEqual([]);
  });

  it.each([
    ["return", "return"], ["return", "throw"], ["throw", "return"], ["throw", "throw"],
  ] as const)("drains unawaited authorization when dispatch will %s and the deferred policy will %s", async (dispatchEnd, policyEnd) => {
    vi.useFakeTimers();
    try {
      const f = networkFixture();
      const started = deferred<void>();
      const policy = deferred<"allow">();
      let policyReads = 0;
      let authorization: Promise<boolean> | undefined;
      let retainedScope: Readonly<OutboundDispatchScope> | undefined;
      f.network.readOrdinaryPolicyOn = vi.fn(async () => {
        policyReads += 1;
        if (policyReads === 1) return "allow";
        started.resolve(undefined);
        return policy.promise;
      });
      f.network.dispatch = vi.fn(async scope => {
        retainedScope = scope;
        authorization = scope.authorize();
        void authorization; // Intentional adapter misuse: the wrapper still owns this work.
        if (dispatchEnd === "throw") throw new Error("synthetic_dispatch_ended_early");
        return { kind: "unknown", providerMessageId: null };
      });
      const running = withServerOwnedOutboundGuard(request, f.network);
      await started.promise;
      await vi.advanceTimersByTimeAsync(0); // Flush dispatch return/throw and cleanup entry only.
      expect(f.release).not.toHaveBeenCalled();
      expect(f.calls.some(call => call.sql.includes("dispatch-rollback"))).toBe(false);
      const beforeDrain = f.calls.length;
      if (policyEnd === "throw") policy.reject(new Error("synthetic_deferred_policy_failure"));
      else policy.resolve("allow");
      const result = await running;
      expect(await authorization).toBe(false);
      expect(result).toMatchObject({ kind: "unconfirmed",
        phase: dispatchEnd === "throw" ? "dispatch" : "dispatch_contract", cleanupFailed: false });
      if (dispatchEnd === "return") expect(result).toHaveProperty("observedOutcome", { kind: "unknown", providerMessageId: null });
      else expect(result).not.toHaveProperty("observedOutcome");
      // After revocation, the deferred read cannot resume shared-guard SQL.
      expect(f.calls.slice(beforeDrain).map(call => call.sql)).toEqual([
        expect.stringContaining("dispatch-rollback"),
      ]);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledWith(false);
      expect(await retainedScope!.authorize()).toBe(false);
      const afterRelease = f.calls.length;
      await expect(retainedScope!.executor.query("SELECT 'after release'"))
        .rejects.toThrow("outbound_query_scope_closed");
      expect(f.calls).toHaveLength(afterRelease);
      expect(f.releasedQueryAttempts).toEqual([]);
      expect(f.network.dispatch).toHaveBeenCalledTimes(1);
      expect(f.network.connect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["policy", "query"] as const)("discards instead of pooling when a pending authorization %s cannot drain", async stalledAt => {
    vi.useFakeTimers();
    try {
      const f = networkFixture();
      const started = deferred<void>();
      const policy = deferred<"allow">();
      const queryResult = deferred<{ rows: Row[]; rowCount: number }>();
      const originalQuery = f.connection.query;
      f.connection.query = async <T extends Row = Row>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("synthetic:pending-policy-query")) {
          started.resolve(undefined);
          return queryResult.promise as unknown as Promise<{ rows: T[]; rowCount: number }>;
        }
        return originalQuery<T>(sql, values);
      };
      let reads = 0;
      let authorization: Promise<boolean> | undefined;
      let retainedScope: Readonly<OutboundDispatchScope> | undefined;
      f.network.readOrdinaryPolicyOn = vi.fn(async executor => {
        reads += 1;
        if (reads === 1) return "allow";
        if (stalledAt === "query") {
          await executor.query("/* synthetic:pending-policy-query */ SELECT 1");
          return "allow";
        }
        started.resolve(undefined);
        return policy.promise;
      });
      f.network.dispatch = vi.fn(async scope => {
        retainedScope = scope;
        authorization = scope.authorize();
        void authorization;
        return { kind: "unknown", providerMessageId: null };
      });
      const running = withServerOwnedOutboundGuard(request, f.network);
      await started.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(f.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(OUTBOUND_AUTHORIZATION_DRAIN_TIMEOUT_MS);
      expect(await running).toEqual({ kind: "unconfirmed", phase: "authorization_drain",
        observedOutcome: { kind: "unknown", providerMessageId: null }, cleanupFailed: true });
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledWith(true);
      expect(f.calls.some(call => call.sql.includes("dispatch-rollback") || call.sql.includes("dispatch-commit"))).toBe(false);
      const afterRelease = f.calls.length;
      // A late settlement after physical discard still cannot begin another SQL call.
      if (stalledAt === "query") queryResult.resolve({ rows: [], rowCount: 0 });
      else policy.resolve("allow");
      expect(await authorization).toBe(false);
      await expect(retainedScope!.executor.query("SELECT 'late after discard'"))
        .rejects.toThrow("outbound_query_scope_closed");
      expect(f.calls).toHaveLength(afterRelease);
      expect(f.releasedQueryAttempts).toEqual([]);
      expect(f.network.dispatch).toHaveBeenCalledTimes(1);
      expect(f.network.connect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("all-purpose outbound guard and explicit occasion permissions", () => {
  it.each(["manual", "reply", "test", "reminder", "occasion", "future-server-purpose"])(
    "blocks %s on endpoint STOP regardless of ordinary consent", async purpose => {
      const f = fixture();
      await recordAuthenticatedEndpointStop(signal(), f.deps);
      expect(await checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT,
        purpose, ordinaryPolicyDecision: "allow" })).toEqual({ allowed: false, reason: "endpoint_suppressed" });
    },
  );

  it("preserves existing noncampaign ordinary defaults without inventing occasion consent", async () => {
    const f = fixture();
    expect(await checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT,
      purpose: "reminder", ordinaryPolicyDecision: "allow" })).toEqual({ allowed: true });
    expect(await checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT,
      purpose: "reminder", ordinaryPolicyDecision: "deny" })).toEqual({ allowed: false, reason: "ordinary_policy_denied" });
    expect(await checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT,
      purpose: "reminder" })).toEqual({ allowed: false, reason: "ordinary_policy_denied" });
    expect(await checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT,
      purpose: "occasion", ordinaryPolicyDecision: "allow" })).toEqual({ allowed: false, reason: "occasion_context_missing" });
    expect(f.state.permissionEvents).toHaveLength(0);
  });

  it("an ordinary or explicit occasion grant cannot clear endpoint STOP", async () => {
    const f = fixture();
    const stop = await recordAuthenticatedEndpointStop(signal(), f.deps);
    await recordOccasionPermission(grant(), f.deps);
    expect(await readEndpointSuppressionOn(f.executor, "whatsapp", ENDPOINT)).toMatchObject({
      status: "suppressed", latestStopEventId: stop.eventId,
    });
    expect(f.state.endpointEvents).toHaveLength(1);
    expect(f.state.permissionEvents).toHaveLength(1);
  });

  it("keeps latest explicit permission immutable, deduplicated, and exact-key scoped", async () => {
    const f = fixture();
    const first = await recordOccasionPermission(grant(), f.deps);
    expect(await recordOccasionPermission(grant(), f.deps)).toEqual({ eventId: first.eventId, replayed: true });
    for (const mismatch of [{ patientId: 2 }, { channel: "sms" as const }, { endpoint: SAME_SUFFIX_OTHER_COUNTRY }, { contactRevision: "other" }]) {
      expect(await readOccasionPermissionOn(f.executor, { ...grant(), ...mismatch })).toBeNull();
    }
    await recordOccasionPermission(grant({ decision: "withdrawn", evidenceKind: "explicit_occasion_withdrawal",
      evidenceId: "withdrawal-evidence", sourceEventId: "withdrawal-1" }), f.deps);
    expect(await readOccasionPermissionOn(f.executor, grant())).toMatchObject({ decision: "withdrawn" });
    await expect(recordOccasionPermission(grant({ evidenceKind: "legacy_consent" } as never), f.deps))
      .rejects.toThrow("explicit_occasion_evidence_required");
    expect(f.state.permissionEvents).toHaveLength(2);
  });

  it("requires current, unique, full endpoint identity for grants", async () => {
    const f = fixture();
    f.deps.readPatientContactProjectionOn = vi.fn(async () => ({ patientId: 1, phone: `+${ENDPOINT}`,
      localCountry: null, contactRevision: "contact-1", identity: "shared" as const }));
    await expect(recordOccasionPermission(grant(), f.deps)).rejects.toThrow("occasion_contact_not_current_or_unique");
    f.deps.readPatientContactProjectionOn = vi.fn(async () => ({ patientId: 1, phone: `+${SAME_SUFFIX_OTHER_COUNTRY}`,
      localCountry: null, contactRevision: "contact-1", identity: "unique" as const }));
    expect(await readOccasionCandidateOn(f.executor, { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT,
      localCountry: null }, f.deps)).toBeNull();
  });

  it("uses authoritative permission and revision at the final occasion gate", async () => {
    const f = fixture();
    const written = await recordOccasionPermission(grant(), f.deps);
    const current = (await readOccasionCandidateOn(f.executor, { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT,
      localCountry: null }, f.deps))!;
    const snapshot: RecipientSnapshot = { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT,
      purpose: "occasion", contactRevision: "contact-1", consentEventId: written.eventId };
    const intent = { channel: "whatsapp" as const, endpoint: ENDPOINT, purpose: "occasion",
      occasion: { snapshot, currentContact: current } };
    expect(await checkServerOwnedOutboundOn(f.executor, intent)).toEqual({ allowed: true });
    await recordOccasionPermission(grant({ decision: "withdrawn", evidenceKind: "explicit_occasion_withdrawal",
      evidenceId: "withdrawal-evidence", sourceEventId: "withdrawal-1" }), f.deps);
    expect(await checkServerOwnedOutboundOn(f.executor, intent)).toEqual({ allowed: false, reason: "occasion_contact_changed" });
  });

  it.each(["contact_change", "merge_survivor"] as const)("%s creates a new revision without transferring grants", async reason => {
    const f = fixture();
    await recordOccasionPermission(grant(), f.deps);
    await f.deps.transaction(tx => recordContactRevisionOn(tx, { patientId: 1, expectedRevision: "contact-1",
      newRevision: "contact-2", reason, evidenceId: "synthetic-contact-evidence" }));
    expect(await readOccasionCandidateOn(f.executor, { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT,
      localCountry: null, expectedContactRevision: "contact-1" }, f.deps)).toBeNull();
    expect(await readOccasionCandidateOn(f.executor, { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT,
      localCountry: null }, f.deps)).toMatchObject({ contactRevision: "contact-2", permission: null });
    await expect(f.deps.transaction(tx => recordContactRevisionOn(tx, { patientId: 1, expectedRevision: "contact-2",
      newRevision: "contact-1", reason: "contact_change", evidenceId: "synthetic-phone-revert" })))
      .rejects.toThrow("synthetic_revision_reuse");
    expect(f.state.permissionEvents).toHaveLength(1);
  });

  it.each(["patient_deleted", "merge_retired"] as const)("%s retires contact identity but retains endpoint STOP", async reason => {
    const f = fixture();
    await recordAuthenticatedEndpointStop(signal(), f.deps);
    await f.deps.transaction(tx => recordContactRevisionOn(tx, { patientId: 1, expectedRevision: "contact-1",
      newRevision: "retired-contact", reason, evidenceId: "synthetic-retirement-evidence" }));
    expect(await readOccasionCandidateOn(f.executor, { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT,
      localCountry: null }, f.deps)).toBeNull();
    expect((await readEndpointSuppressionOn(f.executor, "whatsapp", ENDPOINT)).status).toBe("suppressed");
    await expect(f.deps.transaction(tx => recordContactRevisionOn(tx, { patientId: 1, expectedRevision: null,
      newRevision: "recreated-contact", reason: "initialize", evidenceId: "new-evidence" })))
      .rejects.toThrow("stale_or_retired_contact_revision");
    await f.deps.transaction(tx => recordContactRevisionOn(tx, { patientId: 2, expectedRevision: null,
      newRevision: "new-patient-contact", reason: "initialize", evidenceId: "synthetic-new-patient" }));
    expect(await readOccasionPermissionOn(f.executor, { ...grant(), patientId: 2,
      contactRevision: "new-patient-contact" })).toBeNull();
  });

  it("does not treat client-shaped ordinary consent as an occasion permission", async () => {
    const f = fixture();
    const invented: CandidateContact = { patientId: 1, phone: `+${ENDPOINT}`, localCountry: null,
      identity: "unique", contactRevision: "contact-1", suppression: "clear", permission: {
        eventId: "not-in-db", evidenceId: "invented-evidence", patientId: 1, channel: "whatsapp",
        endpoint: ENDPOINT, purpose: "occasion", contactRevision: "contact-1", decision: "granted",
      } };
    expect(await checkServerOwnedOutboundOn(f.executor, { channel: "whatsapp", endpoint: ENDPOINT, purpose: "occasion",
      occasion: { snapshot: { patientId: 1, channel: "whatsapp", endpoint: ENDPOINT, purpose: "occasion",
        contactRevision: "contact-1", consentEventId: "not-in-db" }, currentContact: invented } }))
      .toEqual({ allowed: false, reason: "occasion_contact_changed" });
  });

  it("source proposal has append-only defenses and no patient cascade or destructive retention", () => {
    expect(OCCASION_CONTACT_SCHEMA_SQL).toContain("UNIQUE (source, source_event_id)");
    expect(OCCASION_CONTACT_SCHEMA_SQL).toContain("BEFORE UPDATE OR DELETE ON messaging_endpoint_events");
    expect(OCCASION_CONTACT_SCHEMA_SQL).toContain("BEFORE TRUNCATE ON occasion_permission_events");
    expect(OCCASION_CONTACT_SCHEMA_SQL).not.toMatch(/REFERENCES\s+patients\b|ON DELETE CASCADE|DROP TABLE|TRUNCATE TABLE/i);
  });
});
