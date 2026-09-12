import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runJourneys, summarize } from "../scripts/verify-ci.mjs";
import { JOURNEYS } from "../scripts/verify-ci-journeys.mjs";

/**
 * حارس البوّابة نفسها.
 *
 * بوّابةٌ تُعلن النجاح بينما سقطت تحتها رحلة أسوأ من لا بوّابة: تعطي إذنَ دمجٍ
 * موقَّعًا على عطب. وبوّابةٌ تُحذف منها رحلةٌ بهدوء تفعل الشيء نفسه ببطء. فهذان
 * الاحتمالان مُثبَتا المنع هنا.
 */
describe("مُنسِّق رحلات التحقق", () => {
  it("سقوط رحلةٍ واحدة يجعل الخروج ١", async () => {
    const results = await runJourneys([
      { phase: 1, name: "ناجحة", script: "__tests__/fixtures/passing-journey.mjs", needsPostgres: false },
      { phase: 1, name: "ساقطة", script: "__tests__/fixtures/failing-journey.mjs", needsPostgres: false },
    ], { postgresAvailable: false });

    expect(results.map((r) => r.status)).toEqual(["PASS", "FAIL"]);
    expect(summarize(results)).toBe(1);
  }, 60_000);

  it("ونجاح الكل يجعله صفرًا — فالأحمر ليس حالَه الدائم", async () => {
    const results = await runJourneys([
      { phase: 1, name: "ناجحة", script: "__tests__/fixtures/passing-journey.mjs", needsPostgres: false },
    ], { postgresAvailable: false });

    expect(summarize(results)).toBe(0);
  }, 60_000);

  it("والرحلة المتخطّاة لنقص البيئة لا تُعدّ ناجحة", async () => {
    const results = await runJourneys([
      { phase: 2, name: "تحتاج خادمًا", script: "__tests__/fixtures/passing-journey.mjs", needsPostgres: true },
    ], { postgresAvailable: false });

    expect(results[0].status).toBe("SKIP");
    expect(summarize(results)).toBe(1);
  });

  it("كل سكربت verify:* في package.json مسجَّلٌ في المُنسِّق", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const declared = Object.entries(pkg.scripts as Record<string, string>)
      .filter(([name]) => name.startsWith("verify:") && name !== "verify:ci")
      .map(([, command]) => command.replace(/^\S+\s+/, "").trim());
    const wired = new Set(JOURNEYS.map((journey) => journey.script));
    const unwired = declared.filter((script) => !wired.has(script));

    expect(unwired, `رحلاتٌ خارج المُنسِّق: ${unwired.join("، ")}`).toEqual([]);
    expect(JOURNEYS.length).toBe(declared.length);
  });
});
