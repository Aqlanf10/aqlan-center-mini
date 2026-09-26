import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_CONFIG } from "../../lib/messaging-channels";

/** (MSG-1) قنوات المراسلة على PostgreSQL 18: السرّ مشفّر ولا يُعاد، والسجل يحفظ كل رسالة. */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, listMessagingChannels, saveMessagingChannel, messagingChannelWithSecret,
  recordMessageDelivery, listMessageDeliveries, createPatient, patientIdForInbound, markDeliveryFailedByProvider } = db;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});
afterAll(async () => { await resetPoolForTesting(); });

describe("messaging channels", () => {
  it("lists all three channels disabled by default", async () => {
    const channels = await listMessagingChannels();
    expect(channels.map((row) => [row.channel, row.enabled, row.hasSecret])).toEqual([
      ["whatsapp", false, false], ["sms", false, false], ["email", false, false],
    ]);
  });

  it("stores the secret encrypted, never returns it, keeps it when omitted, removes it on request — and audits the state only", async () => {
    const config = { url: "https://gw.example/send", method: "POST", bodyFormat: "form", toParam: "to", textParam: "message", senderParam: "sender",
      userParam: "username", keyParam: "api_key", sender: "Aqlan", username: "aqlan", numberFormat: "international", successPattern: "OK",
      inboundKey: "" } as const;
    const saved = await saveMessagingChannel({ channel: "sms", enabled: true, config, secrets: { apiKey: "gw-key-123" }, actor: "owner", actorRole: "admin" });
    expect(saved).toMatchObject({ channel: "sms", enabled: true, hasSecret: true, secretKeys: ["apiKey"] });
    // مفتاح عنوان الاستقبال يُولَّد عند أول حفظ ويبقى ثابتًا.
    const inboundKey = (saved.config as { inboundKey: string }).inboundKey;
    expect(inboundKey.length).toBeGreaterThan(10);
    expect(JSON.stringify(saved)).not.toContain("gw-key-123");

    const [{ secret_enc }] = (await getPool().query<{ secret_enc: string }>(`SELECT secret_enc FROM messaging_channels WHERE channel = 'sms'`)).rows;
    expect(secret_enc).not.toContain("gw-key-123");
    expect(secret_enc).not.toContain("apiKey");
    expect((await messagingChannelWithSecret("sms")).secret).toBe("gw-key-123");

    const kept = await saveMessagingChannel({ channel: "sms", enabled: true, config: { ...config, sender: "Aqlan2" }, actor: "owner", actorRole: "admin" });
    expect((await messagingChannelWithSecret("sms")).secret).toBe("gw-key-123");
    expect((kept.config as { inboundKey: string }).inboundKey).toBe(inboundKey);

    await saveMessagingChannel({ channel: "sms", enabled: false, config, secrets: { apiKey: null }, actor: "owner", actorRole: "admin" });
    expect((await messagingChannelWithSecret("sms")).secret).toBeNull();

    const audit = (await getPool().query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'messaging.channel.update' ORDER BY id`)).rows;
    expect(audit.map((row) => (row.details.keyStates as Record<string, string>).apiKey)).toEqual(["CONFIGURED", "UNCHANGED", "REMOVED"]);
    expect(JSON.stringify(audit)).not.toContain("gw-key-123");
  });

  it("(MSG-3) a partner WhatsApp channel gets a stable generated inbound key alongside the Meta verify token", async () => {
    const config = {
      ...DEFAULT_CONFIG.whatsapp, provider: "bsp" as const, apiBaseUrl: "https://waba-v2.360dialog.io",
      authHeader: "D360-API-KEY", displayNumber: "967730000000",
    };
    const saved = await saveMessagingChannel({ channel: "whatsapp", enabled: true, config, secrets: { token: "bsp-api-key-9" }, actor: "owner", actorRole: "admin" });
    const first = saved.config as { provider: string; inboundKey: string; verifyToken: string };
    expect(first.provider).toBe("bsp");
    expect(first.inboundKey.length).toBeGreaterThan(10);
    expect(first.verifyToken.length).toBeGreaterThan(10);
    const again = await saveMessagingChannel({ channel: "whatsapp", enabled: true, config, actor: "owner", actorRole: "admin" });
    expect((again.config as { inboundKey: string }).inboundKey).toBe(first.inboundKey);
    expect(JSON.stringify(again)).not.toContain("bsp-api-key-9");
    expect((await messagingChannelWithSecret("whatsapp")).secret).toBe("bsp-api-key-9");
  });

  it("records deliveries per patient and never duplicates a provider message id", async () => {
    const patient = await createPatient({
      fullName: "مريض الرسائل", phone: "771000009", altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const entry = { channel: "whatsapp" as const, patientId: patient.id, counterpart: "967771000009", body: "مرحبا", purpose: "manual",
      status: "sent" as const, providerMessageId: "wamid.X", createdBy: "reception" };
    expect(await recordMessageDelivery(entry)).not.toBeNull();
    expect(await recordMessageDelivery(entry)).toBeNull();
    await recordMessageDelivery({ ...entry, providerMessageId: null, status: "failed", error: "خارج نافذة المحادثة" });
    const rows = await listMessageDeliveries({ patientId: patient.id });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "failed", patientName: "مريض الرسائل" });
  });

  it("links an inbound number to the patient we last wrote to, else to a unique phone match — never guesses", async () => {
    const mother = await createPatient({
      fullName: "أم العائلة", phone: "+967 733-222-111", altPhone: null, gender: "female", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const child = await createPatient({
      fullName: "ابن العائلة", phone: null, altPhone: "733222111", gender: "male", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const single = await createPatient({
      fullName: "رقم وحيد", phone: "0775555444", altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(await patientIdForInbound("whatsapp", "967775555444")).toBe(single.id);
    // رقمٌ مشترك بلا مراسلة سابقة ⇒ لا تخمين.
    expect(await patientIdForInbound("whatsapp", "967733222111")).toBeNull();
    await recordMessageDelivery({ channel: "whatsapp", patientId: child.id, counterpart: "967733222111", body: "موعد الابن",
      purpose: "reminder", status: "sent", providerMessageId: "wamid.CHILD", createdBy: null });
    expect(await patientIdForInbound("whatsapp", "967733222111")).toBe(child.id);
    // آخر مراسلة على القناة نفسها هي المرجع — والقناة الأخرى لا تغيّره.
    await recordMessageDelivery({ channel: "sms", patientId: mother.id, counterpart: "733222111", body: "رسالة الأم",
      purpose: "manual", status: "sent", createdBy: "reception" });
    expect(await patientIdForInbound("whatsapp", "967733222111")).toBe(child.id);
    expect(await patientIdForInbound("sms", "733222111")).toBe(mother.id);
    expect(await patientIdForInbound("sms", "12")).toBeNull();
  });

  it("(review) a failed attempt to another family member does not capture the reply", async () => {
    const first = await createPatient({
      fullName: "أخ أول", phone: "733444555", altPhone: null, gender: "male", birthYear: null, address: null, medicalAlert: null, note: null,
    });
    const second = await createPatient({
      fullName: "أخ ثانٍ", phone: "733444555", altPhone: null, gender: "male", birthYear: null, address: null, medicalAlert: null, note: null,
    });
    await recordMessageDelivery({ channel: "whatsapp", patientId: first.id, counterpart: "967733444555", body: "وصلت",
      purpose: "manual", status: "sent", providerMessageId: "wamid.OK1", createdBy: "reception" });
    await recordMessageDelivery({ channel: "whatsapp", patientId: second.id, counterpart: "967733444555", body: "لم تصل",
      purpose: "manual", status: "failed", error: "رُفضت", createdBy: "reception" });
    expect(await patientIdForInbound("whatsapp", "967733444555")).toBe(first.id);
  });

  it("marks a sent message failed when the provider reports it later — only once, only outbound", async () => {
    expect(await markDeliveryFailedByProvider("whatsapp", "wamid.CHILD", "لم تُسلَّم")).toBe(true);
    expect(await markDeliveryFailedByProvider("whatsapp", "wamid.CHILD", "لم تُسلَّم")).toBe(false);
    expect(await markDeliveryFailedByProvider("whatsapp", "wamid.UNKNOWN", "x")).toBe(false);
    const [row] = (await getPool().query<{ status: string; error: string }>(
      `SELECT status, error FROM message_deliveries WHERE provider_message_id = 'wamid.CHILD'`)).rows;
    expect(row).toEqual({ status: "failed", error: "لم تُسلَّم" });
  });
});
