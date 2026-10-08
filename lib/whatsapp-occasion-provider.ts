/**
 * Unpublished WhatsApp occasion adapter. Transport is always injected; no implicit fetch.
 * Intended to sit beside the reviewed core and existing pure channel/Cloud helpers.
 * No function is called as part of this source-preparation task.
 */
import { createHash } from "node:crypto";
import type { WhatsAppChannelConfig } from "./messaging-channels";
import { templatePayload, whatsAppEndpoint, type WhatsAppCloudConfig } from "./whatsapp-cloud";
import type { DispatchOutcome, RecipientSnapshot } from "./occasion-campaign-core";

export type OccasionWhatsAppConfig = WhatsAppChannelConfig & { businessAccountId?: string };
export interface OccasionProviderChannel {
  enabled: boolean;
  /** Changes atomically whenever configuration or credentials change. */
  revision: string;
  config: OccasionWhatsAppConfig;
  secret: string | null;
}
export interface VerifiedOccasionTemplate {
  provider: "meta" | "360dialog";
  scopeDigest: string;
  id: string;
  name: string;
  language: string;
  category: "MARKETING";
  status: "APPROVED";
  senderScopeVerified: boolean;
  /** Exact fixed provider component text, in display order. No patient substitutions. */
  components: readonly Readonly<{ type: "HEADER" | "BODY" | "FOOTER"; text: string }>[];
  renderedText: string;
  contentDigest: string;
  verifiedAtMs: number;
}
export type ProviderBlock = "channel_disabled" | "missing_credentials" | "configuration_incomplete"
  | "unsupported_provider" | "template_unavailable" | "template_unsupported" | "provider_read_failed"
  | "feature_disabled" | "template_review_required" | "binding_changed" | "verification_stale"
  | "recipient_not_authorized" | "dispatch_authorization_unverified" | "sender_scope_unverified";
export type TemplateVerification = { ok: true; template: Readonly<VerifiedOccasionTemplate> } | { ok: false; reason: ProviderBlock };
export interface ProviderDeps {
  fetchImpl: typeof fetch;
  nowMs(): number;
  /** Only a documented authenticated provider read can implement this; no guessed BSP endpoint or operator checkbox. */
  verifyBspSenderScope?(input: { scopeDigest: string; phoneNumberId: string; channelRevision: string }):
    Promise<{ verified: true; scopeDigest: string; phoneNumberId: string; verifiedAtMs: number }>;
}
export interface OccasionSendDeps extends ProviderDeps {
  /** Mandatory live contact/consent/shared STOP and current campaign/config check immediately before I/O. */
  authorizeDispatch(input: {
    recipient: Readonly<RecipientSnapshot>; scopeDigest: string; channelRevision: string; approvedContentDigest: string;
  }): Promise<{ allowed: true } | { allowed: false; reason: "recipient_not_authorized" | "binding_changed" | "feature_disabled" | "channel_disabled" }>;
}
export interface OccasionProviderAttempt {
  outcome: DispatchOutcome;
  reason: "accepted" | "recipient_rejected" | "provider_rejected" | "rate_limited" | "ambiguous_response" | ProviderBlock;
  stopCampaign: boolean;
  /** Unverified diagnostic evidence only; never use it to auto-match a patient or permit retry. */
  receiptEvidence?: readonly string[];
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const TEMPLATE_FRESH_MS = 60_000;
const TIMEOUT_MS = 8_000;
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim();
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
  return value;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
function templateDigest(value: Omit<VerifiedOccasionTemplate, "contentDigest" | "verifiedAtMs">): string {
  return digest({ provider: value.provider, scopeDigest: value.scopeDigest, id: value.id,
    name: value.name, language: value.language, category: value.category, status: value.status,
    senderScopeVerified: value.senderScopeVerified,
    components: value.components.map(component => ({ type: component.type, text: component.text })),
    renderedText: value.renderedText });
}

/** Defensive DTO copy. Never use this for dependencies, streams, or request/session objects. */
export function immutableOccasionValue<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object") return;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("invalid_occasion_snapshot");
    }
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

/** Private-value comparison only: serialized bindings may contain credentials and must never be logged. */
export function sameOccasionValue(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right)); } catch { return false; }
}

function providerContext(channel: OccasionProviderChannel):
  | { ok: true; provider: "meta" | "360dialog"; cloud: WhatsAppCloudConfig; scopeDigest: string }
  | { ok: false; reason: ProviderBlock } {
  if (!record(channel) || channel.enabled !== true) return { ok: false, reason: "channel_disabled" };
  if (!text(channel.secret, 2000)) return { ok: false, reason: "missing_credentials" };
  if (!text(channel.revision)) return { ok: false, reason: "configuration_incomplete" };
  const config = channel.config;
  if (!record(config) || typeof config.phoneNumberId !== "string" || !/^\d{5,30}$/.test(config.phoneNumberId)) {
    return { ok: false, reason: "configuration_incomplete" };
  }
  let provider: "meta" | "360dialog";
  if (config.provider === "meta") {
    if (typeof config.graphVersion !== "string" || !/^v[1-9]\d*\.\d+$/.test(config.graphVersion)
      || typeof config.businessAccountId !== "string" || !/^\d{5,30}$/.test(config.businessAccountId)) {
      return { ok: false, reason: "configuration_incomplete" };
    }
    provider = "meta";
  } else if (config.provider === "bsp" && typeof config.apiBaseUrl === "string"
    && config.apiBaseUrl.replace(/\/+$/, "") === "https://waba-v2.360dialog.io"
    && typeof config.authHeader === "string" && config.authHeader.toLowerCase() === "d360-api-key") {
    provider = "360dialog";
  } else return { ok: false, reason: "unsupported_provider" };
  const scopeDigest = digest({ provider, revision: channel.revision, phoneNumberId: config.phoneNumberId,
    businessAccountId: provider === "meta" ? config.businessAccountId : null,
    graphVersion: provider === "meta" ? config.graphVersion : null,
    base: provider === "360dialog" ? "https://waba-v2.360dialog.io" : "https://graph.facebook.com" });
  return { ok: true, provider, scopeDigest, cloud: {
    token: channel.secret, provider: config.provider, phoneNumberId: config.phoneNumberId,
    graphVersion: config.graphVersion, apiBaseUrl: config.apiBaseUrl, authHeader: config.authHeader,
  } };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("provider_response_too_large");
  }
  if (!response.body) throw new Error("provider_response_empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("provider_response_too_large");
      }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } finally { reader.releaseLock(); }
}

function fixedTextComponents(raw: unknown): VerifiedOccasionTemplate["components"] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) return null;
  const byType = new Map<"HEADER" | "BODY" | "FOOTER", string>();
  for (const item of raw) {
    const component = record(item);
    if (!component || !["HEADER", "BODY", "FOOTER"].includes(String(component.type))) return null;
    const type = component.type as "HEADER" | "BODY" | "FOOTER";
    if (byType.has(type) || typeof component.text !== "string" || !component.text.trim()
      || component.text.length > 4000 || /[{}]/.test(component.text)) return null;
    if (type === "HEADER" && component.format !== "TEXT") return null;
    if (component.format !== undefined && component.format !== "TEXT") return null;
    if (component.buttons !== undefined || component.example !== undefined) return null;
    byType.set(type, component.text);
  }
  if (!byType.has("BODY")) return null;
  const components = (["HEADER", "BODY", "FOOTER"] as const).flatMap(type => {
    const value = byType.get(type);
    return value === undefined ? [] : [Object.freeze({ type, text: value })];
  });
  if (components.map(value => value.text).join("\n\n").length > 4000) return null;
  return Object.freeze(components);
}

/** Authenticated response normalization only; approval is not inferred from a requested name. */
export function parseOccasionTemplate(input: {
  payload: unknown; provider: "meta" | "360dialog"; scopeDigest: string;
  name: string; language: string; verifiedAtMs: number;
  senderScopeVerified?: true;
}): TemplateVerification {
  const payload = record(input.payload);
  // Both current Meta and current 360dialog GET /message_templates contracts return data[].
  const rows = payload?.data;
  if (!Array.isArray(rows) || !Number.isSafeInteger(input.verifiedAtMs) || input.verifiedAtMs < 0) {
    return { ok: false, reason: "template_unavailable" };
  }
  const matches = rows.map(record).filter(row => row?.name === input.name && row?.language === input.language);
  if (matches.length !== 1 || !matches[0]) return { ok: false, reason: "template_unavailable" };
  const row = matches[0];
  if (row.status !== "APPROVED" || row.category !== "MARKETING") return { ok: false, reason: "template_unavailable" };
  // Current-contract id is authoritative. Legacy Hub id/external_id are not interchangeable.
  if (!text(row.id) || row.external_id !== undefined || row["external id"] !== undefined) return { ok: false, reason: "template_unsupported" };
  const components = fixedTextComponents(row.components);
  if (!components) return { ok: false, reason: "template_unsupported" };
  const value = { provider: input.provider, scopeDigest: input.scopeDigest, id: row.id,
    name: input.name, language: input.language, category: "MARKETING" as const, status: "APPROVED" as const,
    senderScopeVerified: input.senderScopeVerified === true,
    components, renderedText: components.map(component => component.text).join("\n\n") };
  return { ok: true, template: Object.freeze({ ...value, contentDigest: templateDigest(value), verifiedAtMs: input.verifiedAtMs }) };
}

export async function verifyOccasionTemplate(input: {
  channel: OccasionProviderChannel; name: string; language: string;
}, deps: ProviderDeps): Promise<TemplateVerification> {
  let requested: typeof input;
  try { requested = immutableOccasionValue(input); }
  catch { return { ok: false, reason: "configuration_incomplete" }; }
  const unchanged = () => sameOccasionValue(input, requested);
  const context = providerContext(requested.channel);
  if (!context.ok) return context;
  if (!/^[a-z0-9_]{1,512}$/.test(requested.name) || !/^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(requested.language)) {
    return { ok: false, reason: "template_unsupported" };
  }
  const url = context.provider === "meta"
    ? new URL(`https://graph.facebook.com/${requested.channel.config.graphVersion}/${requested.channel.config.businessAccountId}/message_templates`)
    : new URL("https://waba-v2.360dialog.io/message_templates");
  if (context.provider === "meta") {
    url.searchParams.set("name", requested.name);
  }
  url.searchParams.set("fields", "id,name,language,status,category,components");
  url.searchParams.set("limit", "100");
  try {
    const headerValues: Record<string, string> = {};
    if (context.provider === "meta") headerValues.authorization = `Bearer ${requested.channel.secret}`;
    else headerValues["D360-API-KEY"] = requested.channel.secret!;
    const headers = Object.freeze(headerValues);
    if (context.provider === "meta") {
      const scopeUrl = new URL(`https://graph.facebook.com/${requested.channel.config.graphVersion}/${requested.channel.config.businessAccountId}/phone_numbers`);
      scopeUrl.searchParams.set("fields", "id");
      scopeUrl.searchParams.set("limit", "100");
      let senderFound = false;
      const seenCursors = new Set<string>();
      for (let page = 0; page < 5; page += 1) {
        const scopeResponse = await deps.fetchImpl(scopeUrl.toString(), { method: "GET", headers,
          redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
        if (!unchanged()) return { ok: false, reason: "binding_changed" };
        if (!scopeResponse.ok) return { ok: false, reason: "provider_read_failed" };
        const scopePayload = record(await boundedJson(scopeResponse));
        if (!unchanged()) return { ok: false, reason: "binding_changed" };
        if (!Array.isArray(scopePayload?.data)) return { ok: false, reason: "sender_scope_unverified" };
        const matches = scopePayload.data.filter(value => record(value)?.id === requested.channel.config.phoneNumberId);
        if (matches.length === 1) { senderFound = true; break; }
        if (matches.length > 1) return { ok: false, reason: "sender_scope_unverified" };
        const paging = record(scopePayload.paging);
        const cursor = record(paging?.cursors)?.after;
        if (!paging?.next || !text(cursor, 2048) || seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
        // Never follow a provider-supplied URL with our authorization header.
        scopeUrl.searchParams.set("after", cursor);
      }
      if (!senderFound) return { ok: false, reason: "sender_scope_unverified" };
    } else {
      if (!deps.verifyBspSenderScope) return { ok: false, reason: "sender_scope_unverified" };
      const proof = await deps.verifyBspSenderScope(Object.freeze({ scopeDigest: context.scopeDigest,
        phoneNumberId: requested.channel.config.phoneNumberId, channelRevision: requested.channel.revision }));
      if (!unchanged()) return { ok: false, reason: "binding_changed" };
      const now = deps.nowMs();
      if (!record(proof) || proof.verified !== true || proof.scopeDigest !== context.scopeDigest
        || proof.phoneNumberId !== requested.channel.config.phoneNumberId || !Number.isSafeInteger(proof.verifiedAtMs)
        || !Number.isSafeInteger(now) || now < proof.verifiedAtMs || now - proof.verifiedAtMs > TEMPLATE_FRESH_MS) {
        return { ok: false, reason: "sender_scope_unverified" };
      }
    }
    const rows: unknown[] = [];
    const seenCursors = new Set<string>();
    let complete = false;
    for (let page = 0; page < 5; page += 1) {
      const response = await deps.fetchImpl(url.toString(), { method: "GET", headers,
        redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
      if (!unchanged()) return { ok: false, reason: "binding_changed" };
      if (!response.ok) return { ok: false, reason: "provider_read_failed" };
      const payload = record(await boundedJson(response));
      if (!unchanged()) return { ok: false, reason: "binding_changed" };
      if (!Array.isArray(payload?.data)) return { ok: false, reason: "template_unavailable" };
      rows.push(...payload.data);
      const paging = record(payload.paging);
      if (!paging?.next) { complete = true; break; }
      const cursor = record(paging.cursors)?.after;
      if (!text(cursor, 2048) || seenCursors.has(cursor)) return { ok: false, reason: "template_unavailable" };
      seenCursors.add(cursor);
      url.searchParams.set("after", cursor);
    }
    if (!complete) return { ok: false, reason: "template_unavailable" };
    const verifiedAtMs = deps.nowMs();
    if (!unchanged()) return { ok: false, reason: "binding_changed" };
    return parseOccasionTemplate({ payload: { data: rows }, provider: context.provider,
      scopeDigest: context.scopeDigest, name: requested.name, language: requested.language, verifiedAtMs, senderScopeVerified: true });
  } catch { return { ok: false, reason: "provider_read_failed" }; }
}

export interface OccasionSendGate {
  featureEnabled: boolean;
  channel: OccasionProviderChannel;
  template: Readonly<VerifiedOccasionTemplate>;
  /** These references come from the server's immutable, admin-reviewed campaign approval. */
  approvedContentDigest: string;
  reviewedGenericOccasion: boolean;
}

export function occasionSendReadiness(gate: OccasionSendGate, nowMs: number): { ok: true } | { ok: false; reason: ProviderBlock } {
  if (!record(gate) || gate.featureEnabled !== true) return { ok: false, reason: "feature_disabled" };
  const context = providerContext(gate.channel);
  if (!context.ok) return context;
  if (gate.reviewedGenericOccasion !== true) return { ok: false, reason: "template_review_required" };
  if (gate.template?.senderScopeVerified !== true) return { ok: false, reason: "sender_scope_unverified" };
  if (!record(gate.template) || !text(gate.template.id) || !text(gate.template.name)
    || !text(gate.template.language) || !Array.isArray(gate.template.components)
    || typeof gate.template.renderedText !== "string" || !gate.template.renderedText.trim()) {
    return { ok: false, reason: "binding_changed" };
  }
  const types = new Set<string>();
  const positions = { HEADER: 0, BODY: 1, FOOTER: 2 } as const;
  let previous = -1;
  for (const component of gate.template.components) {
    const componentType: unknown = record(component)?.type;
    if ((componentType !== "HEADER" && componentType !== "BODY" && componentType !== "FOOTER")
      || !record(component) || !Object.hasOwn(positions, componentType) || Object.keys(component).length !== 2
      || typeof component.text !== "string" || !component.text.trim() || component.text.length > 4000
      || /[{}]/.test(component.text) || types.has(componentType) || positions[componentType] <= previous) {
      return { ok: false, reason: "binding_changed" };
    }
    types.add(componentType);
    previous = positions[componentType];
  }
  if (!types.has("BODY") || gate.template.components.length > 3
    || gate.template.renderedText !== gate.template.components.map(component => component.text).join("\n\n")
    || gate.template.renderedText.length > 4000 || !/^[a-z0-9_]{1,512}$/.test(gate.template.name)
    || !/^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(gate.template.language)) return { ok: false, reason: "binding_changed" };
  const { contentDigest, verifiedAtMs } = gate.template;
  if (gate.template.provider !== context.provider || gate.template.scopeDigest !== context.scopeDigest
    || gate.template.status !== "APPROVED" || gate.template.category !== "MARKETING"
    || templateDigest(gate.template) !== contentDigest || gate.approvedContentDigest !== contentDigest) return { ok: false, reason: "binding_changed" };
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(verifiedAtMs) || nowMs < verifiedAtMs
    || nowMs - verifiedAtMs > TEMPLATE_FRESH_MS) return { ok: false, reason: "verification_stale" };
  return { ok: true };
}

/** Only called after the DB has atomically authorized and claimed this exact recipient. */
export async function sendOccasionTemplate(gate: OccasionSendGate, recipient: Readonly<RecipientSnapshot>, deps: OccasionSendDeps): Promise<OccasionProviderAttempt> {
  let captured: { gate: OccasionSendGate; recipient: Readonly<RecipientSnapshot> };
  try { captured = immutableOccasionValue({ gate, recipient }); }
  catch { return { outcome: { kind: "not_accepted", retryable: false }, reason: "binding_changed", stopCampaign: true }; }
  const unchanged = () => sameOccasionValue({ gate, recipient }, captured);
  const readiness = occasionSendReadiness(captured.gate, deps.nowMs());
  if (!readiness.ok) return { outcome: { kind: "not_accepted", retryable: false }, reason: readiness.reason, stopCampaign: true };
  const endpoint = captured.recipient.endpoint;
  if (captured.recipient.channel !== "whatsapp" || captured.recipient.purpose !== "occasion" || !Number.isSafeInteger(captured.recipient.patientId)
    || captured.recipient.patientId <= 0 || !text(captured.recipient.contactRevision) || !text(captured.recipient.consentEventId)
    || typeof endpoint !== "string" || !/^[1-9]\d{7,14}$/.test(endpoint)) {
    return { outcome: { kind: "not_accepted", retryable: false }, reason: "recipient_rejected", stopCampaign: false };
  }
  const context = providerContext(captured.gate.channel);
  if (!context.ok) return { outcome: { kind: "not_accepted", retryable: false }, reason: context.reason, stopCampaign: true };
  const endpointRequest = whatsAppEndpoint(context.cloud);
  const request = immutableOccasionValue({ url: endpointRequest.url, headers: endpointRequest.headers,
    body: JSON.stringify(templatePayload({ to: endpoint, templateName: captured.gate.template.name,
      languageCode: captured.gate.template.language, bodyParams: [] })) });
  const authorizationBinding = immutableOccasionValue({ recipient: captured.recipient, scopeDigest: captured.gate.template.scopeDigest,
    channelRevision: captured.gate.channel.revision, approvedContentDigest: captured.gate.approvedContentDigest });
  let observedReceipt: string | null = null;
  const unknown = (): OccasionProviderAttempt => ({ outcome: { kind: "unknown" }, reason: "ambiguous_response", stopCampaign: true,
    ...(observedReceipt === null ? {} : { receiptEvidence: Object.freeze([observedReceipt]) }) });
  try {
    const authorization = await deps.authorizeDispatch(authorizationBinding);
    if (!unchanged()) return { outcome: { kind: "not_accepted", retryable: false }, reason: "binding_changed", stopCampaign: true };
    if (!record(authorization)) throw new Error("invalid_dispatch_authorization");
    if (authorization.allowed === false && Object.keys(authorization).length === 2
      && ["recipient_not_authorized", "binding_changed", "feature_disabled", "channel_disabled"].includes(authorization.reason)) {
      return { outcome: { kind: "not_accepted", retryable: false }, reason: authorization.reason,
        stopCampaign: authorization.reason !== "recipient_not_authorized" };
    }
    if (authorization.allowed !== true || Object.keys(authorization).length !== 1) throw new Error("invalid_dispatch_authorization");
  } catch {
    return { outcome: { kind: "not_accepted", retryable: false }, reason: "dispatch_authorization_unverified", stopCampaign: true };
  }
  const finalReadiness = occasionSendReadiness(captured.gate, deps.nowMs());
  if (!finalReadiness.ok) return { outcome: { kind: "not_accepted", retryable: false }, reason: finalReadiness.reason, stopCampaign: true };
  if (!unchanged()) return { outcome: { kind: "not_accepted", retryable: false }, reason: "binding_changed", stopCampaign: true };
  try {
    const response = await deps.fetchImpl(request.url, { method: "POST", headers: request.headers,
      body: request.body,
      redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const payload = record(await boundedJson(response));
    const messages = payload?.messages;
    const possibleReceipt = Array.isArray(messages) && messages.length === 1 ? record(messages[0])?.id : null;
    if (text(possibleReceipt) && /^[A-Za-z0-9:+._=/-]+$/.test(possibleReceipt)
      && !possibleReceipt.includes(captured.gate.channel.secret!)) observedReceipt = possibleReceipt;
    if (response.ok && !payload?.error && Array.isArray(messages) && messages.length === 1) {
      const id = record(messages[0])?.id;
      if (!text(id) || observedReceipt !== id) return unknown();
      const contacts = payload?.contacts;
      if (contacts !== undefined && (!Array.isArray(contacts) || contacts.length !== 1 || record(contacts[0])?.wa_id !== endpoint)) return unknown();
      return { outcome: { kind: "accepted", providerMessageId: id }, reason: "accepted", stopCampaign: false };
    }
    // Only explicit known 4xx provider errors establish non-acceptance; 5xx/transport/malformed results remain uncertain.
    if (messages !== undefined || response.status < 400 || response.status >= 500) return unknown();
    const code = record(payload?.error)?.code;
    if (typeof code !== "number" || !Number.isSafeInteger(code)) return unknown();
    if ([130429, 131056].includes(code) && response.status === 429) {
      return { outcome: { kind: "not_accepted", retryable: true }, reason: "rate_limited", stopCampaign: true };
    }
    if ([190, 132000, 132001, 131005].includes(code)) {
      return { outcome: { kind: "not_accepted", retryable: false }, reason: "provider_rejected", stopCampaign: true };
    }
    if ([131026, 131047].includes(code)) {
      return { outcome: { kind: "not_accepted", retryable: false }, reason: "recipient_rejected", stopCampaign: false };
    }
    return unknown();
  } catch { return unknown(); }
}
