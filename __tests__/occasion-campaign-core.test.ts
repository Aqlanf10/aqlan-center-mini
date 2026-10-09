import { describe, expect, it } from "vitest";
import {
  applyDeliveryStatus, applyDispatchOutcome, campaignDispatchPhase, cancelUnclaimedRecipient,
  claimRecipient, compareSendIntent, createSendIntent, evaluateOccasionRecipient, expireClaim,
  freezeOccasionSnapshot, isOccasionChannel, isRecipientState, normalizeOccasionPhone, prepareOccasionRecipients, queuedRecipient,
  recheckOccasionRecipient, resolveOccasionPhone, retryRejectedRecipient,
  type CandidateContact, type DispatchOutcome, type OccasionChannel, type OccasionTemplateSnapshot, type RecipientSnapshot,
  type RecipientState,
} from "../lib/occasion-campaign-core";

// Synthetic identifiers and phone fixtures only. No imports that initialize DB/network/provider clients.
function contact(channel: OccasionChannel = "whatsapp", patientId = 1, phone = "770000001"): CandidateContact {
  return {
    patientId, phone, localCountry: "YE", contactRevision: "contact-v1", identity: "unique", suppression: "clear",
    permission: {
      eventId: `consent-${patientId}`, patientId, channel, purpose: "occasion",
      endpoint: normalizeOccasionPhone(phone, "YE")!, contactRevision: "contact-v1",
      decision: "granted", evidenceId: `evidence-${patientId}`,
    },
  };
}
function recipient(value = contact(), channel: OccasionChannel = "whatsapp"): Readonly<RecipientSnapshot> {
  const result = evaluateOccasionRecipient(value, channel);
  if (!result.eligible) throw new Error(`fixture_not_eligible:${result.reason}`);
  return result.recipient;
}
function template(channel: OccasionChannel = "whatsapp"): OccasionTemplateSnapshot {
  return {
    templateId: "generic-greeting", revision: "preset-v1", channel, language: "ar",
    body: "كل عام وأنتم بخير. نتمنى لكم أيامًا سعيدة.", providerTemplateName: null,
  };
}
function claimed(): Readonly<RecipientState> {
  return claimRecipient(queuedRecipient(), {
    campaignActive: true, snapshot: recipient(), currentContact: contact(), attemptId: "attempt-1",
  });
}
function accepted(): Readonly<RecipientState> {
  return applyDispatchOutcome(claimed(), "attempt-1", { kind: "accepted", providerMessageId: "provider-1" });
}
function callback(status: "sent" | "delivered" | "read" | "failed") {
  return { attemptId: "attempt-1", providerMessageId: "provider-1", status };
}

describe("strict supported destination normalization", () => {
  it("limits the foundation to the two selectable channels without choosing either", () => {
    expect(isOccasionChannel("whatsapp")).toBe(true);
    expect(isOccasionChannel("sms")).toBe(true);
    expect(isOccasionChannel("email")).toBe(false);
    expect(evaluateOccasionRecipient(contact(), "email" as OccasionChannel)).toEqual({ eligible: false, reason: "invalid_channel" });
  });
  it.each(["770000001", "0770000001", "+967 770 000 001", "00967770000001", "967770000001", "٧٧٠٠٠٠٠٠١", "۷۷۰۰۰۰۰۰۱"])("normalizes %s consistently", input => {
    expect(normalizeOccasionPhone(input, "YE")).toBe("967770000001");
  });
  it.each([null, undefined, "", "04-000000", "96770000000", "9677700000011", "+0123456789", "+1234567890123456", "770000001 ext 2", "https://wa.me/967770000001", "770000001,770000002"])("refuses %s instead of guessing", input => {
    expect(normalizeOccasionPhone(input, "YE")).toBeNull();
  });
  it("preserves explicit international numbers without rewriting them into Yemen", () => {
    for (const country of [null, "YE"] as const) {
      expect(normalizeOccasionPhone("+966 50 000 0001", country)).toBe("966500000001");
      expect(normalizeOccasionPhone("0015550000001", country)).toBe("15550000001");
      expect(normalizeOccasionPhone("+770000001", country)).toBe("770000001");
    }
  });
  it("requires explicit country context for local numbers and labels unsupported local formats precisely", () => {
    expect(resolveOccasionPhone("770000001", null)).toEqual({ ok: false, reason: "local_country_required" });
    expect(resolveOccasionPhone("0500000001", "YE")).toEqual({ ok: false, reason: "unsupported_local_phone" });
    expect(resolveOccasionPhone("not a phone", "YE")).toEqual({ ok: false, reason: "invalid_phone_syntax" });
    expect(resolveOccasionPhone("---", "YE")).toEqual({ ok: false, reason: "invalid_phone_syntax" });
    expect(resolveOccasionPhone(null, "YE")).toEqual({ ok: false, reason: "missing_phone" });
  });
});

describe.each(["whatsapp", "sms"] as const)("%s occasion eligibility", channel => {
  it("requires an affirmative grant for this exact endpoint/channel/purpose/contact revision", () => {
    const value = contact(channel);
    expect(evaluateOccasionRecipient(value, channel)).toMatchObject({ eligible: true, recipient: {
      channel, purpose: "occasion", endpoint: "967770000001", consentEventId: "consent-1",
    } });
  });
  it("does not use the application's legacy opt-out default", () => {
    expect(evaluateOccasionRecipient({ ...contact(channel), permission: null }, channel))
      .toEqual({ eligible: false, reason: "consent_missing" });
  });
  it.each(["shared", "unknown"] as const)("excludes %s identity", identity => {
    expect(evaluateOccasionRecipient({ ...contact(channel), identity }, channel))
      .toEqual({ eligible: false, reason: "identity_ambiguous" });
  });
  it("suppression wins over even a valid grant and ambiguous identity", () => {
    expect(evaluateOccasionRecipient({ ...contact(channel), suppression: "suppressed", identity: "shared" }, channel))
      .toEqual({ eligible: false, reason: "suppressed" });
    expect(evaluateOccasionRecipient({ ...contact(channel), suppression: "unknown" }, channel))
      .toEqual({ eligible: false, reason: "suppression_unknown" });
  });
  it("rejects withdrawn, wrong destination/channel/purpose/person and missing evidence grants", () => {
    const value = contact(channel);
    const grant = value.permission!;
    const patches = [
      { endpoint: "967770000002" }, { channel: channel === "sms" ? "whatsapp" as const : "sms" as const },
      { purpose: "reminder" as "occasion" }, { patientId: 2 }, { evidenceId: null }, { eventId: "" },
    ];
    for (const patch of patches) {
      expect(evaluateOccasionRecipient({ ...value, permission: { ...grant, ...patch } }, channel))
        .toEqual({ eligible: false, reason: "consent_mismatch" });
    }
    expect(evaluateOccasionRecipient({ ...value, permission: { ...grant, decision: "withdrawn" } }, channel))
      .toEqual({ eligible: false, reason: "consent_withdrawn" });
  });
  it("fails closed on a changed contact even if a former number is later restored", () => {
    expect(evaluateOccasionRecipient({ ...contact(channel), contactRevision: "contact-v2" }, channel))
      .toEqual({ eligible: false, reason: "contact_changed" });
  });
});

describe("recipient preparation and dispatch-time recheck", () => {
  it("keeps country prefixes in identity and does not merge matching last-nine digits", () => {
    const international = { ...contact("whatsapp", 2, "+966770000001"), localCountry: null };
    const result = prepareOccasionRecipients([contact(), international], "whatsapp");
    expect(result.recipients.map(row => row.endpoint)).toEqual(["966770000001", "967770000001"]);
    expect(result.excluded).toEqual([]);
  });
  it("deduplicates repeated identical contacts without exposing linked family identities", () => {
    const prepared = prepareOccasionRecipients([contact(), { ...contact(), phone: "+967 770000001" }], "whatsapp");
    expect(prepared.recipients).toHaveLength(1);
    expect(prepared.excluded).toEqual([{ patientId: 1, reason: "duplicate_destination" }]);
    expect(Object.keys(prepared.recipients[0]).sort()).toEqual([
      "channel", "consentEventId", "contactRevision", "endpoint", "patientId", "purpose",
    ]);
  });
  it("excludes all different patients sharing a normalized destination, rather than picking the first", () => {
    for (const rows of [[contact(), contact("whatsapp", 2)], [contact("whatsapp", 2), contact()]]) {
      const prepared = prepareOccasionRecipients(rows, "whatsapp");
      expect(prepared.recipients).toEqual([]);
      expect(prepared.excluded.every(row => row.reason === "identity_ambiguous")).toBe(true);
    }
  });
  it("a suppression or withdrawn duplicate row prevents an otherwise eligible duplicate from sending", () => {
    const first = contact();
    for (const second of [
      { ...contact(), suppression: "suppressed" as const },
      { ...contact(), permission: { ...contact().permission!, decision: "withdrawn" as const } },
    ]) {
      expect(prepareOccasionRecipients([first, second], "whatsapp").recipients).toEqual([]);
      expect(prepareOccasionRecipients([second, first], "whatsapp").recipients).toEqual([]);
    }
  });
  it("conflicting snapshots for the same patient/destination are excluded", () => {
    const second = contact();
    second.permission = { ...second.permission!, eventId: "another-current-grant" };
    const result = prepareOccasionRecipients([contact(), second], "whatsapp");
    expect(result.recipients).toEqual([]);
    expect(result.excluded.every(row => row.reason === "conflicting_snapshot")).toBe(true);
  });
  it("a new grant, changed phone, new ambiguity or STOP after preview requires exclusion/review", () => {
    const snapshot = recipient();
    expect(recheckOccasionRecipient(snapshot, contact()).eligible).toBe(true);
    for (const current of [
      contact("whatsapp", 1, "770000002"),
      { ...contact(), identity: "shared" as const },
      { ...contact(), suppression: "suppressed" as const },
      { ...contact(), permission: { ...contact().permission!, eventId: "new-grant" } },
    ]) expect(recheckOccasionRecipient(snapshot, current).eligible).toBe(false);
  });
});

describe("immutable snapshots and repeat-send equivalence", () => {
  const make = (rows = [recipient(), recipient(contact("whatsapp", 2, "770000002"))], key = "request_key_000001") =>
    createSendIntent({ campaignId: "campaign-1", draftRevision: 1, idempotencyKey: key,
      snapshot: freezeOccasionSnapshot(template(), rows) });
  it("freezes copies rather than retaining mutable input arrays/objects", () => {
    const originalTemplate = template();
    const originalRows = [recipient()];
    const snapshot = freezeOccasionSnapshot(originalTemplate, originalRows);
    originalTemplate.body = "changed after preview";
    originalRows.length = 0;
    expect(snapshot.template.body).toBe(template().body);
    expect(snapshot.recipients).toHaveLength(1);
    expect([snapshot, snapshot.template, snapshot.recipients, snapshot.recipients[0]].every(Object.isFrozen)).toBe(true);
  });
  it("canonicalizes order, replays the same send, and prevents a new key from resending the same campaign", () => {
    const first = make();
    const reversed = make([recipient(contact("whatsapp", 2, "770000002")), recipient()]);
    expect(compareSendIntent(null, first)).toBe("new");
    expect(compareSendIntent(first, reversed)).toBe("replay");
    expect(compareSendIntent(first, make(undefined, "request_key_000002"))).toBe("replay");
  });
  it("conflicts if the campaign, revision, recipients, text or provider template binding changes", () => {
    const first = make();
    expect(compareSendIntent(first, { ...first, campaignId: "campaign-2" })).toBe("conflict");
    expect(compareSendIntent(first, { ...first, draftRevision: 2 })).toBe("conflict");
    expect(compareSendIntent(first, make([recipient()]))).toBe("conflict");
    for (const update of [{ body: "تحية طيبة وتمنياتنا لكم بأيام سعيدة." }, { providerTemplateName: "provider_greeting" }]) {
      const proposed = createSendIntent({ campaignId: "campaign-1", draftRevision: 1, idempotencyKey: first.idempotencyKey,
        snapshot: freezeOccasionSnapshot({ ...template(), ...update }, [recipient(), recipient(contact("whatsapp", 2, "770000002"))]) });
      expect(compareSendIntent(first, proposed)).toBe("conflict");
    }
  });
  it("accepts a provider-unbound draft without claiming sendability, but refuses an empty send intent", () => {
    const snapshot = freezeOccasionSnapshot(template(), []);
    expect(snapshot.template.providerTemplateName).toBeNull();
    expect(() => createSendIntent({ campaignId: "campaign-1", draftRevision: 1, idempotencyKey: "request_key_000001", snapshot }))
      .toThrow("empty_or_inconsistent_send_intent");
  });
  it("rejects mismatched channels, duplicate endpoints and personalized placeholder bodies", () => {
    expect(() => freezeOccasionSnapshot(template("sms"), [recipient()])).toThrow("invalid_recipient_snapshot");
    expect(() => freezeOccasionSnapshot(template(), [recipient(), recipient()])).toThrow("invalid_recipient_snapshot");
    expect(() => freezeOccasionSnapshot({ ...template(), body: "مرحبًا {{patientName}}" }, [])).toThrow("invalid_template_snapshot");
  });
});

describe("dispatch state contracts", () => {
  it("claims only queued work in an active campaign and rechecks the approved recipient", () => {
    expect(claimed().status).toBe("claimed");
    expect(() => claimRecipient(queuedRecipient(), {
      campaignActive: false, snapshot: recipient(), currentContact: contact(), attemptId: "attempt-1",
    })).toThrow("campaign_not_active");
    expect(claimRecipient(queuedRecipient(), {
      campaignActive: true, snapshot: recipient(), currentContact: contact("whatsapp", 2), attemptId: "attempt-1",
    }).status).toBe("suppressed");
    expect(() => claimRecipient(claimed(), {
      campaignActive: true, snapshot: recipient(), currentContact: contact(), attemptId: "attempt-2",
    })).toThrow("recipient_not_queued");
  });
  it("provider acceptance is distinct from delivered; blank receipts and unknown outcomes remain uncertain", () => {
    expect(accepted().status).toBe("accepted");
    expect(applyDispatchOutcome(claimed(), "attempt-1", { kind: "accepted", providerMessageId: "" }).status).toBe("uncertain");
    expect(applyDispatchOutcome(claimed(), "attempt-1", { kind: "unknown" })).toMatchObject({ status: "uncertain", retryable: false });
    expect(() => applyDispatchOutcome(claimed(), "stale-attempt", { kind: "unknown" })).toThrow("stale_dispatch_attempt");
  });
  it("a crashed/expired attempt never automatically returns to queued", () => {
    const uncertain = expireClaim(claimed(), "attempt-1");
    expect(uncertain.status).toBe("uncertain");
    expect(() => retryRejectedRecipient(uncertain, { campaignActive: true, snapshot: recipient(), currentContact: contact() }))
      .toThrow("retry_not_allowed");
  });
  it("cancellation changes only unclaimed work and does not claim a provider recall", () => {
    expect(cancelUnclaimedRecipient(queuedRecipient()).status).toBe("cancelled");
    for (const state of [claimed(), accepted(), expireClaim(claimed(), "attempt-1")]) {
      expect(cancelUnclaimedRecipient(state)).toBe(state);
    }
  });
  it("only definitively unaccepted retryable attempts may be requeued, with a fresh eligibility check", () => {
    const rejected = applyDispatchOutcome(claimed(), "attempt-1", { kind: "not_accepted", retryable: true });
    const input = { campaignActive: true, snapshot: recipient(), currentContact: contact() };
    expect(retryRejectedRecipient(rejected, input).status).toBe("queued");
    expect(retryRejectedRecipient(rejected, { ...input, currentContact: { ...contact(), suppression: "suppressed" } }).status).toBe("suppressed");
    expect(() => retryRejectedRecipient(rejected, { ...input, campaignActive: false })).toThrow("retry_not_allowed");
    expect(() => retryRejectedRecipient({ ...rejected, retryable: false }, input)).toThrow("retry_not_allowed");
    expect(() => retryRejectedRecipient(accepted(), input)).toThrow("retry_not_allowed");
  });
  it("requires matching attempt and provider receipt for delivery callbacks", () => {
    expect(() => applyDeliveryStatus(accepted(), { ...callback("delivered"), providerMessageId: "other" })).toThrow("unmatched_delivery_event");
    expect(() => applyDeliveryStatus(accepted(), { ...callback("delivered"), attemptId: "other" })).toThrow("unmatched_delivery_event");
  });
  it("accepts verified delivery/read evidence without requiring intermediate callbacks and never regresses it", () => {
    const delivered = applyDeliveryStatus(accepted(), callback("delivered"));
    expect(delivered.status).toBe("delivered");
    expect(applyDeliveryStatus(delivered, callback("sent"))).toBe(delivered);
    expect(applyDeliveryStatus(delivered, callback("failed"))).toBe(delivered);
    const read = applyDeliveryStatus(delivered, callback("read"));
    expect(applyDeliveryStatus(read, callback("delivered"))).toBe(read);
    expect(applyDeliveryStatus(read, callback("read"))).toBe(read);
  });
  it("does not retry reported delivery failure, and later positive delivery evidence can resolve out-of-order failure", () => {
    const failed = applyDeliveryStatus(accepted(), callback("failed"));
    expect(failed).toMatchObject({ status: "failed", retryable: false });
    expect(applyDeliveryStatus(failed, callback("sent"))).toBe(failed);
    expect(applyDeliveryStatus(failed, callback("delivered")).status).toBe("delivered");
  });
  it("reports dispatch completion separately from delivery and keeps cancellation/uncertainty visible", () => {
    expect(campaignDispatchPhase([], { sendAuthorized: false, cancelRequested: false })).toBe("draft");
    expect(campaignDispatchPhase([accepted()], { sendAuthorized: true, cancelRequested: false })).toBe("dispatch_complete");
    expect(campaignDispatchPhase([claimed()], { sendAuthorized: true, cancelRequested: true })).toBe("cancelling");
    expect(campaignDispatchPhase([queuedRecipient()], { sendAuthorized: true, cancelRequested: true })).toBe("cancelling");
    expect(campaignDispatchPhase([cancelUnclaimedRecipient(queuedRecipient()), accepted()], { sendAuthorized: true, cancelRequested: true })).toBe("cancelled");
    expect(campaignDispatchPhase([expireClaim(claimed(), "attempt-1")], { sendAuthorized: true, cancelRequested: true })).toBe("needs_attention");
  });
});

describe("corrupt persistence and adapter boundaries", () => {
  const rawCorruptStates: unknown[] = [
    null, undefined, {}, [], "queued",
    { ...queuedRecipient(), status: "future_unknown_state" },
    { ...queuedRecipient(), providerMessageId: "receipt-already-exists" },
    { status: "rejected", attemptId: "attempt-1", providerMessageId: "receipt-already-exists", retryable: true },
    { ...queuedRecipient(), attemptId: "attempt-with-unknown-history" },
    { status: "claimed", attemptId: "attempt-1", providerMessageId: "receipt-already-exists", retryable: false },
    { status: "rejected", attemptId: null, providerMessageId: null, retryable: true },
    { status: "rejected", attemptId: "attempt-1", providerMessageId: null, retryable: "false" },
    { status: "uncertain", attemptId: "attempt-1", providerMessageId: null, retryable: true },
    { status: "accepted", attemptId: "attempt-1", providerMessageId: null, retryable: false },
    { status: "delivered", attemptId: "attempt-1", providerMessageId: "receipt", retryable: true },
    { status: "suppressed", attemptId: null, providerMessageId: "receipt", retryable: false },
    { status: "cancelled", attemptId: "attempt-1", providerMessageId: null, retryable: false },
    { ...queuedRecipient(), retryable: 0 },
    { ...queuedRecipient(), acceptedAt: "evidence-that-cannot-be-ignored" },
  ];
  it.each(rawCorruptStates.map((value, index) => [index, value] as const))("rejects corrupt state %s before every transition", (_index, raw) => {
    expect(isRecipientState(raw)).toBe(false);
    const state = raw as RecipientState;
    expect(() => claimRecipient(state, { campaignActive: true, snapshot: recipient(), currentContact: contact(), attemptId: "attempt-2" }))
      .toThrow("invalid_recipient_state");
    expect(() => retryRejectedRecipient(state, { campaignActive: true, snapshot: recipient(), currentContact: contact() }))
      .toThrow("invalid_recipient_state");
    expect(() => cancelUnclaimedRecipient(state)).toThrow("invalid_recipient_state");
    expect(() => applyDispatchOutcome(state, "attempt-1", { kind: "unknown" })).toThrow("invalid_recipient_state");
    expect(() => applyDeliveryStatus(state, callback("delivered"))).toThrow("invalid_recipient_state");
    expect(() => campaignDispatchPhase([state], { sendAuthorized: true, cancelRequested: false })).toThrow("invalid_recipient_state");
  });
  it("never erases accepted receipt evidence to requeue or claim", () => {
    const corruptedRejected = { status: "rejected", attemptId: "attempt-1", providerMessageId: "provider-1", retryable: true };
    const corruptedQueued = { status: "queued", attemptId: null, providerMessageId: "provider-1", retryable: false };
    expect(() => retryRejectedRecipient(corruptedRejected as unknown as RecipientState, {
      campaignActive: true, snapshot: recipient(), currentContact: contact(),
    })).toThrow("invalid_recipient_state");
    expect(() => claimRecipient(corruptedQueued as unknown as RecipientState, {
      campaignActive: true, snapshot: recipient(), currentContact: contact(), attemptId: "attempt-2",
    })).toThrow("invalid_recipient_state");
    expect(corruptedRejected.providerMessageId).toBe("provider-1");
    expect(corruptedQueued.providerMessageId).toBe("provider-1");
  });
  it.each([undefined, null, 0, 1, "true", "false", "unknown", {}, []])("requires a literal true activation flag, not %s", raw => {
    expect(() => claimRecipient(queuedRecipient(), {
      campaignActive: raw as unknown as boolean, snapshot: recipient(), currentContact: contact(), attemptId: "attempt-2",
    })).toThrow("campaign_not_active");
    const rejected = applyDispatchOutcome(claimed(), "attempt-1", { kind: "not_accepted", retryable: true });
    expect(() => retryRejectedRecipient(rejected, {
      campaignActive: raw as unknown as boolean, snapshot: recipient(), currentContact: contact(),
    })).toThrow("retry_not_allowed");
    expect(() => campaignDispatchPhase([], { sendAuthorized: raw as unknown as boolean, cancelRequested: false })).toThrow("invalid_campaign_flags");
    expect(() => campaignDispatchPhase([], { sendAuthorized: true, cancelRequested: raw as unknown as boolean })).toThrow("invalid_campaign_flags");
  });
  it("does not turn malformed rejection data or extra receipt evidence into retry permission", () => {
    for (const raw of [
      null, undefined, "not_accepted", { kind: "future_unknown_outcome" },
      { kind: "not_accepted", retryable: "false" },
      { kind: "not_accepted", retryable: true, providerMessageId: "provider-1" },
      { kind: "accepted", providerMessageId: "provider-1", retryable: true },
    ]) {
      const result = applyDispatchOutcome(claimed(), "attempt-1", raw as DispatchOutcome);
      expect(result).toMatchObject({ status: "uncertain", retryable: false });
      expect(() => retryRejectedRecipient(result, { campaignActive: true, snapshot: recipient(), currentContact: contact() }))
        .toThrow("retry_not_allowed");
    }
  });
  it("does not create a state that its own invariant rejects", () => {
    expect(() => claimRecipient(queuedRecipient(), {
      campaignActive: true, snapshot: recipient(), currentContact: contact(), attemptId: " attempt-with-space ",
    })).toThrow("invalid_attempt_id");
    const validStates = [queuedRecipient(), claimed(), accepted(), expireClaim(claimed(), "attempt-1"),
      cancelUnclaimedRecipient(queuedRecipient()),
      applyDispatchOutcome(claimed(), "attempt-1", { kind: "not_accepted", retryable: false }),
      applyDispatchOutcome(claimed(), "attempt-1", { kind: "not_accepted", retryable: true }),
      applyDeliveryStatus(accepted(), callback("sent")), applyDeliveryStatus(accepted(), callback("failed")),
      applyDeliveryStatus(accepted(), callback("delivered")), applyDeliveryStatus(accepted(), callback("read"))];
    expect(validStates.every(isRecipientState)).toBe(true);
  });
  it("reconciles uncertainty only from an authenticated callback matching an already known exact receipt", () => {
    const uncertainWithReceipt: RecipientState = {
      status: "uncertain", attemptId: "attempt-1", providerMessageId: "provider-1", retryable: false,
    };
    expect(applyDeliveryStatus(uncertainWithReceipt, callback("delivered"))).toMatchObject({
      status: "delivered", attemptId: "attempt-1", providerMessageId: "provider-1", retryable: false,
    });
    expect(() => applyDeliveryStatus(expireClaim(claimed(), "attempt-1"), callback("delivered")))
      .toThrow("unmatched_delivery_event");
    expect(() => applyDeliveryStatus(uncertainWithReceipt, { ...callback("delivered"), providerMessageId: "other" }))
      .toThrow("unmatched_delivery_event");
  });
});
