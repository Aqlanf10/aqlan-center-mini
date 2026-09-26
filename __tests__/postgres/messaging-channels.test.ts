import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (MSG-1) قنوات المراسلة على PostgreSQL 18: السرّ مشفّر ولا يُعاد، والسجل يحفظ كل رسالة. */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, listMessagingChannels, saveMessagingChannel, messagingChannelWithSecret,
  recordMessageDelivery, listMessageDeliveries, createPatient } = db;

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
});
