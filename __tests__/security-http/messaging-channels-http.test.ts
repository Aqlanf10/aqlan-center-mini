import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/** (MSG-1) قنوات المراسلة على التطبيق المبني: للمدير، السرّ لا يعود، والقناة المعطّلة تقول ذلك. */

let h: Awaited<ReturnType<typeof harness>>;
const arabic = /[؀-ۿ]/;
beforeAll(async () => { h = await harness(); });

describe("/api/settings/messaging", () => {
  it("is admin-only", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorA]) {
      expect((await authedGet("/api/settings/messaging", session)).status).toBe(403);
    }
  });

  it("refuses to enable a channel without its secret, and never returns a saved secret", async () => {
    const config = { host: "smtp.example.com", port: 587, security: "starttls", username: "clinic", fromAddress: "clinic@example.com", fromName: "المركز" };
    const refused = await authedMutation("/api/settings/messaging", h.sessions.admin, "PUT", JSON.stringify({ channel: "email", enabled: true, config }));
    expect(refused.status).toBe(400);
    expect((await refused.json() as { message: string }).message).toMatch(arabic);

    const saved = await authedMutation("/api/settings/messaging", h.sessions.admin, "PUT",
      JSON.stringify({ channel: "email", enabled: false, config, secrets: { password: "mail-pass-777" } }));
    expect(saved.status).toBe(200);
    const listed = await authedGet("/api/settings/messaging", h.sessions.admin);
    const text = await listed.text();
    expect(text).not.toContain("mail-pass-777");
    expect(text).toContain("\"hasSecret\":true");
    expect(text).toContain("\"secretKeys\":[\"password\"]");
  });
});

describe("/api/messages/outbound", () => {
  it("a disabled channel is refused in Arabic; doctors and the cashier cannot send", async () => {
    const response = await authedMutation("/api/messages/outbound", h.sessions.reception, "POST",
      JSON.stringify({ channel: "whatsapp", to: "771000001", body: "مرحبا" }));
    expect(response.status).toBe(409);
    expect((await response.json() as { message: string }).message).toMatch(arabic);
    for (const session of [h.sessions.doctorA, h.sessions.cashier]) {
      const denied = await authedMutation("/api/messages/outbound", session, "POST",
        JSON.stringify({ channel: "sms", to: "771000001", body: "x" }));
      expect(denied.status).toBe(403);
    }
  });
});

describe("/api/webhooks (MSG-2)", () => {
  it("are reachable without a session but refuse unsigned or unkeyed deliveries without storing anything", async () => {
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "967771000001", id: "wamid.HTTP", type: "text", text: { body: "مزوّر" } }] } }] }] });
    const unsigned = await fetch(`${baseUrl}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    expect(unsigned.status).toBe(403);
    expect((await unsigned.json() as { message: string }).message).toMatch(arabic);
    const forged = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: payload,
    });
    expect(forged.status).toBe(403);

    const verify = await fetch(`${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1`);
    expect(verify.status).toBe(403);

    for (const url of ["/api/webhooks/sms?from=771000001&text=x", "/api/webhooks/sms?key=guess&from=771000001&text=x"]) {
      expect((await fetch(`${baseUrl}${url}`)).status).toBe(403);
      expect((await fetch(`${baseUrl}${url}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "from=771000001&text=x" })).status).toBe(403);
    }

    const log = await authedGet("/api/messages/outbound", h.sessions.admin);
    expect(await log.text()).not.toContain("مزوّر");
  });
});
