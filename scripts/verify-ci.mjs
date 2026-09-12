#!/usr/bin/env node
import "./load-env.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JOURNEYS, PHASE_TITLE } from "./verify-ci-journeys.mjs";

/**
 * npm run verify:ci — مُنسِّق رحلات التحقق التشغيلية.
 *
 * كان الفحص الآليّ يمرّ على الأنواع والاختبارات والبناء ثم يخضرّ — ولا يشغّل
 * **أيًّا** من ثمانيَ عشرةَ رحلةً تشغيلية. فكان أخضره يعني «تُرجم البرنامج»، لا
 * «يعمل». وخمسٌ منها كانت ساقطةً فعلًا وقتَ كتابة هذا الملف بلا أن يعلم أحد.
 *
 * قاعدته: لا فشلَ صامت. كل رحلة تُشغَّل بعمليةٍ مستقلة (فلا تتسرّب بيئةُ رحلةٍ إلى
 * أخرى ولا يُسقط انهيارُ واحدةٍ البقيةَ)، ومخرجاتها تمرّ كما هي — لا ابتلاعَ
 * stderr — ثم يُطبع جدولٌ ختاميّ ويكون الخروج ١ إن سقطت واحدة.
 *
 * وتُشغَّل كلها حتى لو سقطت الأولى: مراجعةٌ واحدة تُرى فيها كل الأعطال أنفع من
 * خمس دوراتٍ يكشف كلٌّ منها عطبًا واحدًا.
 */

const isPostgresAvailable = Boolean((process.env.DATABASE_URL ?? "").trim())
  && process.env.USE_LOCAL_DB !== "true";

function runJourney(journey) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n▶ START ${journey.name} — ${journey.script}`);
    const child = spawn("npx", ["tsx", journey.script], {
      stdio: "inherit",
      env: process.env,
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    child.on("error", (error) => {
      console.error(`  تعذّر تشغيل ${journey.name}: ${error.message}`);
      resolve({ ...journey, status: "FAIL", seconds: (Date.now() - started) / 1000, code: -1 });
    });
    child.on("close", (code) => {
      const seconds = (Date.now() - started) / 1000;
      const status = code === 0 ? "PASS" : "FAIL";
      console.log(`${status === "PASS" ? "✔" : "✘"} ${status} ${journey.name} — ${seconds.toFixed(1)} ثانية`);
      resolve({ ...journey, status, seconds, code });
    });
  });
}

/** يُشغّل قائمة رحلات ويعيد نتائجها — مفصولٌ عن `main` ليُختبر بقائمةٍ مصطنعة. */
export async function runJourneys(journeys, { postgresAvailable = isPostgresAvailable } = {}) {
  const results = [];
  let phase = null;
  for (const journey of journeys) {
    if (journey.phase !== phase) {
      phase = journey.phase;
      console.log(`\n═══ ${PHASE_TITLE[phase] ?? `المرحلة ${phase}`} ═══`);
    }
    if (journey.needsPostgres && !postgresAvailable) {
      console.error(`✘ SKIP ${journey.name} — DATABASE_URL غير مضبوط، والرحلة تحتاج خادم PostgreSQL.`);
      results.push({ ...journey, status: "SKIP", seconds: 0, code: null });
      continue;
    }
    results.push(await runJourney(journey));
  }
  return results;
}

/** المتخطّى ليس ناجحًا: بيئةٌ ناقصة في CI عطبٌ يُعلن لا رخصةٌ للمرور. */
export function summarize(results) {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log("\n═══ الخلاصة ═══");
  console.log(`  ${"الرحلة".padEnd(width)}  الحال   المرحلة  الثواني`);
  for (const result of results) {
    console.log(`  ${result.name.padEnd(width)}  ${result.status.padEnd(6)}  ${String(result.phase).padEnd(7)}`
      + `  ${result.seconds.toFixed(1)}`);
  }
  const passed = results.filter((r) => r.status === "PASS");
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log(`\n  ${passed.length}/${results.length} نجحت`
    + (failed.length > 0 ? ` · ${failed.length} سقطت: ${failed.map((r) => r.name).join("، ")}` : "")
    + (skipped.length > 0 ? ` · ${skipped.length} تُخطّيت: ${skipped.map((r) => r.name).join("، ")}` : ""));
  return failed.length === 0 && skipped.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const results = await runJourneys(JOURNEYS);
  process.exit(summarize(results));
}
