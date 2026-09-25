import { describe, expect, it } from "vitest";
import { baseUrl } from "./_server";

/** (P2-12) نقطة جولة التذكير الآلي: بلا سرٍّ مهيَّأ فشلٌ مغلق برسالة عربية — لا إرسال. */

describe("/api/internal/reminders/run", () => {
  it("is closed until its token is configured, and says so in Arabic", async () => {
    const response = await fetch(`${baseUrl}/api/internal/reminders/run`, {
      method: "POST",
      headers: { authorization: "Bearer guess", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(503);
    const payload = await response.json() as { message: string };
    expect(payload.message).toMatch(/[؀-ۿ]/);
  });
});
