import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";

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
