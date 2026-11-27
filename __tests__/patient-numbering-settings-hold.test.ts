import { expect, it, vi } from "vitest";
import { PATCH, POST } from "../app/api/settings/route";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "fixture-admin" }) }));
vi.mock("@/lib/db", () => ({ saveSettingsAudited: save }));

it("keeps the general settings writer and reset closed to an administrator without a verified owner binding", async () => {
  const settings = { "patients.number_prefix": "T", "patients.number_start": "4310" };
  for (const [handler, body] of [[PATCH, settings], [POST, { action: "reset", keys: Object.keys(settings) }]] as const) {
    const response = await handler(
      new Request("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  }
});
