import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../lib/messaging-channels";
import type { RecipientSnapshot } from "../lib/occasion-campaign-core";
import {
  occasionSendReadiness, parseOccasionTemplate, sendOccasionTemplate, verifyOccasionTemplate,
  type OccasionProviderChannel, type OccasionSendGate, type OccasionSendDeps, type VerifiedOccasionTemplate,
} from "../lib/whatsapp-occasion-provider";

const NOW = 1_800_000_000_000;
const channel = (): OccasionProviderChannel => ({
  enabled: true, revision: "synthetic-channel-v1", secret: "synthetic-not-a-real-token",
  config: { ...DEFAULT_CONFIG.whatsapp, phoneNumberId: "12345678", businessAccountId: "87654321" },
});
const rawTemplate = () => ({ id: "template-1", name: "owner_chosen_greeting", language: "ar",
  status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "كل عام وأنتم بخير. تمنياتنا لكم بأيام سعيدة." }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const recipient = (): RecipientSnapshot => ({ patientId: 1, channel: "whatsapp", purpose: "occasion",
  endpoint: "966500000001", contactRevision: "contact-v1", consentEventId: "consent-1" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(customChannel = channel(), raw = rawTemplate()) {
  const transport = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => String(url).includes("/phone_numbers")
    ? json({ data: [{ id: customChannel.config.phoneNumberId }] }) : json({ data: [raw] }));
  const deps: OccasionSendDeps = { fetchImpl: transport as typeof fetch, nowMs: () => NOW,
    authorizeDispatch: vi.fn(async () => ({ allowed: true as const })) };
  const verified = await verifyOccasionTemplate({ channel: customChannel, name: raw.name, language: raw.language }, deps);
  if (!verified.ok) throw new Error(`bad_fixture:${verified.reason}`);
  const gate: OccasionSendGate = { featureEnabled: true, channel: customChannel, template: verified.template,
    approvedContentDigest: verified.template.contentDigest, reviewedGenericOccasion: true };
  transport.mockClear();
  return { transport, deps, gate };
}

describe("WhatsApp occasion template verification", () => {
  it("performs a read-only exact-name Meta lookup using the existing configured secret and account", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => String(url).includes("/phone_numbers")
      ? json({ data: [{ id: channel().config.phoneNumberId }] }) : json({ data: [rawTemplate()] }));
    const result = await verifyOccasionTemplate({ channel: channel(), name: "owner_chosen_greeting", language: "ar" },
      { fetchImpl: transport as typeof fetch, nowMs: () => NOW });
    expect(result.ok).toBe(true);
    expect(String(transport.mock.calls[0][0])).toContain("/87654321/phone_numbers?");
    const [url, init] = transport.mock.calls[1];
    expect(String(url)).toContain("https://graph.facebook.com/v21.0/87654321/message_templates?");
    expect(String(url)).toContain("name=owner_chosen_greeting");
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(init?.headers).toEqual({ authorization: "Bearer synthetic-not-a-real-token" });
    expect(JSON.stringify(result)).not.toContain("synthetic-not-a-real-token");
  });
  it("supports owner-selected approved fixed text, not only hard-coded preset wording", async () => {
    const different = { ...rawTemplate(), name: "another_approved_occasion", components: [
      { type: "BODY", text: "تهنئة طيبة بهذه المناسبة من المركز، مع أصدق التمنيات بالسعادة." },
    ] };
    const { gate } = await fixture(channel(), different);
    expect(occasionSendReadiness(gate, NOW)).toEqual({ ok: true });
    expect(gate.template.renderedText).toBe(different.components[0].text);
  });
  it("refuses a template from a WABA that does not contain the configured sender", async () => {
    const transport = vi.fn(async () => json({ data: [{ id: "another-phone-id" }] }));
    expect(await verifyOccasionTemplate({ channel: channel(), name: rawTemplate().name, language: "ar" },
      { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW }))
      .toEqual({ ok: false, reason: "sender_scope_unverified" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("uses only opaque cursors on the fixed Meta host while checking sender membership", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/phone_numbers")) return String(url).includes("after=cursor-2")
        ? json({ data: [{ id: channel().config.phoneNumberId }] })
        : json({ data: [], paging: { next: "https://untrusted.example/steal", cursors: { after: "cursor-2" } } });
      return json({ data: [rawTemplate()] });
    });
    expect((await verifyOccasionTemplate({ channel: channel(), name: rawTemplate().name, language: "ar" },
      { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW })).ok).toBe(true);
    expect(transport.mock.calls.every(([url]) => String(url).startsWith("https://graph.facebook.com/"))).toBe(true);
    expect(String(transport.mock.calls[1][0])).toContain("after=cursor-2");
  });
  it("uses only the documented 360dialog read endpoint for the recognized BSP", async () => {
    const bsp = channel();
    bsp.config = { ...bsp.config, provider: "bsp", apiBaseUrl: "https://waba-v2.360dialog.io", authHeader: "D360-API-KEY" };
    const raw = { ...rawTemplate(), id: "bsp-template-1" };
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ data: [raw] }));
    const result = await verifyOccasionTemplate({ channel: bsp, name: raw.name, language: raw.language },
      { fetchImpl: transport as typeof fetch, nowMs: () => NOW,
        verifyBspSenderScope: async input => ({ verified: true, scopeDigest: input.scopeDigest, phoneNumberId: input.phoneNumberId, verifiedAtMs: NOW }) });
    expect(result).toMatchObject({ ok: true, template: { provider: "360dialog", id: "bsp-template-1", status: "APPROVED" } });
    expect(String(transport.mock.calls[0][0])).toContain("https://waba-v2.360dialog.io/message_templates?");
    expect(transport.mock.calls[0][1]?.headers).toEqual({ "D360-API-KEY": "synthetic-not-a-real-token" });
  });
  it("does not accept the deprecated BSP response or conflate legacy Hub and Meta template IDs", () => {
    const input = { provider: "360dialog" as const, scopeDigest: "scope", name: rawTemplate().name, language: "ar", verifiedAtMs: NOW };
    const legacy = { ...rawTemplate(), id: "hub-id", external_id: "meta-id" };
    expect(parseOccasionTemplate({ ...input, payload: { waba_templates: [legacy] } }).ok).toBe(false);
    expect(parseOccasionTemplate({ ...input, payload: { data: [legacy] } }).ok).toBe(false);
    expect(parseOccasionTemplate({ ...input, payload: { data: [{ ...rawTemplate(), id: "current-id" }] } }))
      .toMatchObject({ ok: true, template: { id: "current-id" } });
  });
  it("uses bounded fixed-host cursor pagination for current BSP templates and rejects incomplete scans", async () => {
    const bsp = channel();
    bsp.config = { ...bsp.config, provider: "bsp", apiBaseUrl: "https://waba-v2.360dialog.io", authHeader: "D360-API-KEY" };
    const transport = vi.fn(async (url: RequestInfo | URL) => String(url).includes("after=next-page")
      ? json({ data: [rawTemplate()] })
      : json({ data: [], paging: { next: "https://untrusted.example/", cursors: { after: "next-page" } } }));
    const deps = { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW,
      verifyBspSenderScope: async (input: { scopeDigest: string; phoneNumberId: string }) => ({
        verified: true as const, scopeDigest: input.scopeDigest, phoneNumberId: input.phoneNumberId, verifiedAtMs: NOW,
      }) };
    expect((await verifyOccasionTemplate({ channel: bsp, name: rawTemplate().name, language: "ar" }, deps)).ok).toBe(true);
    expect(transport.mock.calls.every(([url]) => String(url).startsWith("https://waba-v2.360dialog.io/message_templates?"))).toBe(true);
    transport.mockClear();
    let page = 0;
    transport.mockImplementation(async () => json({ data: [rawTemplate()], paging: { next: "more", cursors: { after: `page-${++page}` } } }));
    expect((await verifyOccasionTemplate({ channel: bsp, name: rawTemplate().name, language: "ar" }, deps)).ok).toBe(false);
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it("rejects sender/config mutation during a deferred sender-scope lookup", async () => {
    const waiting = deferred<Response>();
    const input = { channel: channel(), name: rawTemplate().name, language: "ar" };
    const transport = vi.fn(() => waiting.promise);
    const result = verifyOccasionTemplate(input, { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW });
    input.channel.config.phoneNumberId = "99999999";
    input.channel.secret = "different-synthetic-token";
    waiting.resolve(json({ data: [{ id: "12345678" }] }));
    expect(await result).toEqual({ ok: false, reason: "binding_changed" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects selected-template mutation while its response is pending", async () => {
    const started = deferred<void>();
    const waiting = deferred<Response>();
    const input = { channel: channel(), name: rawTemplate().name, language: "ar" };
    const transport = vi.fn((url: RequestInfo | URL) => {
      if (String(url).includes("/phone_numbers")) return Promise.resolve(json({ data: [{ id: "12345678" }] }));
      started.resolve(undefined); return waiting.promise;
    });
    const result = verifyOccasionTemplate(input, { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW });
    await started.promise;
    input.name = "changed_during_lookup";
    waiting.resolve(json({ data: [rawTemplate()] }));
    expect(await result).toEqual({ ok: false, reason: "binding_changed" });
  });
  it("blocks disabled/missing/unknown configuration without invoking transport", async () => {
    const cases = [
      { ...channel(), enabled: false }, { ...channel(), enabled: "true" as unknown as boolean },
      { ...channel(), secret: null }, { ...channel(), revision: "" },
      { ...channel(), config: { ...channel().config, businessAccountId: undefined } },
      { ...channel(), config: { ...channel().config, provider: "bsp" as const, apiBaseUrl: "https://unrecognized.example" } },
    ];
    for (const candidate of cases) {
      const transport = vi.fn();
      expect((await verifyOccasionTemplate({ channel: candidate, name: "owner_chosen_greeting", language: "ar" },
        { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW })).ok).toBe(false);
      expect(transport).not.toHaveBeenCalled();
    }
  });
  it("keeps a recognized BSP blocked without an authoritative current sender-scope verifier", async () => {
    const bsp = channel();
    bsp.config = { ...bsp.config, provider: "bsp", apiBaseUrl: "https://waba-v2.360dialog.io", authHeader: "D360-API-KEY" };
    const transport = vi.fn();
    expect(await verifyOccasionTemplate({ channel: bsp, name: rawTemplate().name, language: "ar" },
      { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW }))
      .toEqual({ ok: false, reason: "sender_scope_unverified" });
    expect(transport).not.toHaveBeenCalled();
    expect(await verifyOccasionTemplate({ channel: bsp, name: rawTemplate().name, language: "ar" },
      { fetchImpl: transport as unknown as typeof fetch, nowMs: () => NOW,
        verifyBspSenderScope: async input => ({ verified: true, scopeDigest: input.scopeDigest, phoneNumberId: "wrong-phone", verifiedAtMs: NOW }) }))
      .toEqual({ ok: false, reason: "sender_scope_unverified" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("refuses unapproved/wrong-category/ambiguous/missing-ID templates and variable/media/button components", () => {
    const rows = [
      { ...rawTemplate(), status: "PAUSED" }, { ...rawTemplate(), category: "UTILITY" }, { ...rawTemplate(), id: undefined },
      { ...rawTemplate(), id: "id-1", external_id: "id-2" },
      { ...rawTemplate(), components: [{ type: "BODY", text: "مرحبًا {{patientName}}" }] },
      { ...rawTemplate(), components: [{ type: "HEADER", format: "IMAGE" }, ...rawTemplate().components] },
      { ...rawTemplate(), components: [{ type: "BUTTONS", buttons: [] }, ...rawTemplate().components] },
      { ...rawTemplate(), components: [{ type: "BODY", format: "IMAGE", text: "not a valid fixed-text body" }] },
    ];
    for (const row of rows) expect(parseOccasionTemplate({ payload: { data: [row] }, provider: "meta", scopeDigest: "scope",
      name: row.name, language: row.language, verifiedAtMs: NOW }).ok).toBe(false);
    expect(parseOccasionTemplate({ payload: { data: [rawTemplate(), rawTemplate()] }, provider: "meta", scopeDigest: "scope",
      name: rawTemplate().name, language: "ar", verifiedAtMs: NOW }).ok).toBe(false);
  });
  it("sanitizes a failed read and rejects oversized provider data", async () => {
    for (const response of [json({ error: { message: "sensitive raw provider text" } }, 403),
      new Response("x".repeat(300_000), { status: 200 })]) {
      const result = await verifyOccasionTemplate({ channel: channel(), name: rawTemplate().name, language: "ar" },
        { fetchImpl: vi.fn(async () => response) as unknown as typeof fetch, nowMs: () => NOW });
      expect(result).toEqual({ ok: false, reason: "provider_read_failed" });
      expect(JSON.stringify(result)).not.toContain("sensitive");
    }
  });
});

describe("occasion send readiness and response classification", () => {
  it("keeps the same binding after a JSONB-like property reordering, while changed values still conflict", async () => {
    const { gate } = await fixture();
    const reordered = Object.fromEntries(Object.entries(gate.template).reverse()) as unknown as VerifiedOccasionTemplate;
    reordered.components = gate.template.components.map(component => Object.fromEntries(Object.entries(component).reverse())) as unknown as VerifiedOccasionTemplate["components"];
    expect(occasionSendReadiness({ ...gate, template: reordered }, NOW)).toEqual({ ok: true });
    expect(occasionSendReadiness({ ...gate, template: { ...reordered, language: "en" } }, NOW))
      .toEqual({ ok: false, reason: "binding_changed" });
  });
  it.each(["template", "sender", "secret", "recipient"] as const)("rejects %s mutation during deferred authorization without POST", async kind => {
    const { gate, deps, transport } = await fixture();
    const target = recipient();
    const alternateChannel = channel();
    alternateChannel.config.phoneNumberId = "99999999";
    alternateChannel.revision = "other-channel-revision";
    const alternate = await fixture(kind === "sender" ? alternateChannel : channel(), {
      ...rawTemplate(), name: "another_ready_template", components: [{ type: "BODY", text: "تحية طيبة بمناسبة سعيدة." }],
    });
    const waiting = deferred<{ allowed: true }>();
    deps.authorizeDispatch = vi.fn(() => waiting.promise);
    const pending = sendOccasionTemplate(gate, target, deps);
    if (kind === "template") { gate.template = alternate.gate.template; gate.approvedContentDigest = alternate.gate.approvedContentDigest; }
    if (kind === "sender") { gate.channel = alternate.gate.channel; gate.template = alternate.gate.template; gate.approvedContentDigest = alternate.gate.approvedContentDigest; }
    if (kind === "secret") gate.channel.secret = "changed-synthetic-secret";
    if (kind === "recipient") { target.endpoint = "967770000001"; target.consentEventId = "changed-grant"; }
    waiting.resolve({ allowed: true });
    expect(await pending).toMatchObject({ outcome: { kind: "not_accepted", retryable: false }, reason: "binding_changed", stopCampaign: true });
    expect(transport).not.toHaveBeenCalled();
  });
  it("authorizes a defensively frozen recipient/content binding and sends precisely those unchanged values", async () => {
    const { gate, deps, transport } = await fixture();
    const target = recipient();
    let observed: Parameters<OccasionSendDeps["authorizeDispatch"]>[0] | null = null;
    deps.authorizeDispatch = vi.fn(async binding => { observed = binding;
      expect(Object.isFrozen(binding)).toBe(true); expect(Object.isFrozen(binding.recipient)).toBe(true);
      return { allowed: true as const }; });
    transport.mockImplementation(async () => json({ messages: [{ id: "exact-receipt" }], contacts: [{ wa_id: target.endpoint }] }));
    expect((await sendOccasionTemplate(gate, target, deps)).outcome).toEqual({ kind: "accepted", providerMessageId: "exact-receipt" });
    expect(observed).toEqual({ recipient: target, scopeDigest: gate.template.scopeDigest,
      channelRevision: gate.channel.revision, approvedContentDigest: gate.approvedContentDigest });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({ to: target.endpoint,
      template: { name: gate.template.name, language: { code: gate.template.language } } });
  });
  it("requires a fresh explicit server authorization including shared STOP immediately before POST", async () => {
    const { gate, deps, transport } = await fixture();
    for (const denial of ["recipient_not_authorized", "binding_changed", "feature_disabled", "channel_disabled"] as const) {
      deps.authorizeDispatch = vi.fn(async () => ({ allowed: false as const, reason: denial }));
      expect(await sendOccasionTemplate(gate, recipient(), deps)).toEqual({
        outcome: { kind: "not_accepted", retryable: false }, reason: denial, stopCampaign: denial !== "recipient_not_authorized",
      });
      expect(deps.authorizeDispatch).toHaveBeenCalledWith({ recipient: recipient(), scopeDigest: gate.template.scopeDigest,
        channelRevision: gate.channel.revision, approvedContentDigest: gate.approvedContentDigest });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not contact the provider when authorization fails, is missing, or is only truthy", async () => {
    const { gate, deps, transport } = await fixture();
    for (const value of [undefined, null, true, { allowed: "true" }, { allowed: true, reason: "contradiction" }, { allowed: false }]) {
      deps.authorizeDispatch = vi.fn(async () => value) as unknown as OccasionSendDeps["authorizeDispatch"];
      expect(await sendOccasionTemplate(gate, recipient(), deps)).toMatchObject({ reason: "dispatch_authorization_unverified",
        outcome: { kind: "not_accepted", retryable: false }, stopCampaign: true });
    }
    deps.authorizeDispatch = vi.fn(async () => { throw new Error("synthetic consent read failure"); });
    expect((await sendOccasionTemplate(gate, recipient(), deps)).reason).toBe("dispatch_authorization_unverified");
    expect(transport).not.toHaveBeenCalled();
  });
  it("rechecks verification freshness if the live authorization lookup took too long", async () => {
    const { gate, deps, transport } = await fixture();
    let now = NOW;
    deps.nowMs = () => now;
    deps.authorizeDispatch = vi.fn(async () => { now += 60_001; return { allowed: true as const }; });
    expect((await sendOccasionTemplate(gate, recipient(), deps)).reason).toBe("verification_stale");
    expect(transport).not.toHaveBeenCalled();
  });
  it("blocks default-off feature, missing review, changed binding/config and stale/future verification without POST", async () => {
    const { gate, deps, transport } = await fixture();
    const gates: OccasionSendGate[] = [
      { ...gate, featureEnabled: false }, { ...gate, featureEnabled: "true" as unknown as boolean },
      { ...gate, reviewedGenericOccasion: false }, { ...gate, approvedContentDigest: "another-preview" },
      { ...gate, channel: { ...gate.channel, revision: "channel-v2" } },
      { ...gate, template: { ...gate.template, renderedText: "changed after approval" } },
      { ...gate, template: { ...gate.template, verifiedAtMs: NOW - 60_001 } },
      { ...gate, template: { ...gate.template, verifiedAtMs: NOW + 1 } },
    ];
    for (const blocked of gates) {
      expect((await sendOccasionTemplate(blocked, recipient(), deps)).outcome).toEqual({ kind: "not_accepted", retryable: false });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends the exact static approved template to an international recipient and reports only provider acceptance", async () => {
    const { gate, deps, transport } = await fixture();
    transport.mockImplementation(async () => json({ messages: [{ id: "provider-receipt-1" }], contacts: [{ wa_id: "966500000001" }] }));
    expect(await sendOccasionTemplate(gate, recipient(), deps)).toEqual({
      outcome: { kind: "accepted", providerMessageId: "provider-receipt-1" }, reason: "accepted", stopCampaign: false,
    });
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe("https://graph.facebook.com/v21.0/12345678/messages");
    expect(JSON.parse(String(init?.body))).toEqual({ messaging_product: "whatsapp", to: "966500000001", type: "template",
      template: { name: "owner_chosen_greeting", language: { code: "ar" }, components: [] } });
    expect(init?.redirect).toBe("error");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("never retries a timeout, malformed success, missing receipt, conflicting recipient, or 5xx", async () => {
    const { gate, deps, transport } = await fixture();
    const responses = [json({}), json({ messages: [{ id: "" }] }),
      json({ messages: [{ id: "receipt" }], error: { code: 190 } }),
      json({ messages: [{ id: "receipt" }], contacts: [{ wa_id: "967770000001" }] }),
      json({ error: { code: 130429 } }, 503), new Response("not-json", { status: 200 })];
    for (const response of responses) {
      transport.mockClear(); transport.mockImplementation(async () => response);
      expect(await sendOccasionTemplate(gate, recipient(), deps)).toMatchObject({
        outcome: { kind: "unknown" }, reason: "ambiguous_response", stopCampaign: true,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }
    transport.mockClear(); transport.mockImplementation(async () => { throw new Error("synthetic transport timeout"); });
    expect((await sendOccasionTemplate(gate, recipient(), deps)).outcome).toEqual({ kind: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("preserves safe unverified receipt evidence on a contradictory response without claiming acceptance", async () => {
    const { gate, deps, transport } = await fixture();
    transport.mockImplementation(async () => json({ messages: [{ id: "receipt-to-reconcile" }], error: { code: 190 } }));
    expect(await sendOccasionTemplate(gate, recipient(), deps)).toEqual({
      outcome: { kind: "unknown" }, reason: "ambiguous_response", stopCampaign: true,
      receiptEvidence: ["receipt-to-reconcile"],
    });
  });
  it("classifies only known explicit rejections, stopping the campaign on provider-wide problems", async () => {
    const { gate, deps, transport } = await fixture();
    for (const [status, code, retryable, reason, stop] of [
      [429, 130429, true, "rate_limited", true], [401, 190, false, "provider_rejected", true],
      [400, 132001, false, "provider_rejected", true], [400, 131026, false, "recipient_rejected", false],
    ] as const) {
      transport.mockImplementation(async () => json({ error: { code } }, status));
      expect(await sendOccasionTemplate(gate, recipient(), deps)).toEqual({
        outcome: { kind: "not_accepted", retryable }, reason, stopCampaign: stop,
      });
    }
    transport.mockImplementation(async () => json({ error: { code: 999999 } }, 400));
    expect((await sendOccasionTemplate(gate, recipient(), deps)).outcome).toEqual({ kind: "unknown" });
  });
});
