#!/usr/bin/env node
import "./load-env.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * npm run verify:full — البوابةُ المحلية الكاملة الواحدة (TD-02 / TD-REG-013).
 *
 * قبلها كان «npm test نجح» يعني أن الوحدات نجحت — لا أن البوابة الإلزامية
 * نجحت: اختبارات PostgreSQL الحقيقية ورحلات التحقق واختبارات الأمن على HTTP
 * خارج `npm test` بتصميمٍ (كلٌّ منها يحتاج بيئته)، فكان الفرقُ بين الجهاز
 * المحلي وCI فرقًا يعرفُه مَن قرأ ملف الـworkflow فقط.
 *
 * هذه البوابة تُشغّل العقد نفسه الذي يفرضه CI — البوابات كلها، بالترتيب
 * نفسه، بلا تخطٍّ صامت: أي عائق بيئة (Node مخالف، قاعدة غائبة، Chromium غائب)
 * فشلٌ صريحٌ مُعلَّن السبب، لا اجتيازٌ بالتخطي. الخطوات لا تُستثنى بإعدادٍ
 * محلي: من يريد بوابةً أسرع يشغّل الخطوة بنفسه بوعي — أما «الكل» فتعني الكل.
 *
 * متطلبات قبل التشغيل (يفحصها هذا السكربت ويشرحها عند غيابها):
 *  * Node داخل العقد (‎.nvmrc / engines) — يفحصها verify:environment أولًا.
 *  * قاعدة PostgreSQL 18 حقيقية (docker compose up -d pg18).
 *  * Chromium لرحلات المتصفح (npx playwright install --with-deps chromium).
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** خطوات البوابة الكاملة — يُختبر وجودُ كلٍّ منها في __tests__/environment-parity.test.ts. */
export const FULL_GATE_STEPS = [
  { name: "عقد البيئة", command: ["npm", "run", "verify:environment"] },
  { name: "الأنواع", command: ["npm", "run", "typecheck"] },
  { name: "التنقيط", command: ["npm", "run", "lint"] },
  { name: "اختبارات الوحدة", command: ["npm", "test"] },
  { name: "اختبارات PostgreSQL الحقيقية", command: ["npm", "run", "test:postgres"] },
  { name: "رحلات التحقق التشغيلية", command: ["npm", "run", "verify:ci"] },
  { name: "تدقيق الاعتماديات", command: ["npm", "run", "ci:audit"] },
  { name: "ماسح قارئات الأجسام", command: ["npm", "run", "ci:scan:body"] },
  { name: "بناء الإنتاج", command: ["npm", "run", "build"] },
  { name: "اختبارات الأمن على HTTP", command: ["npm", "run", "test:security-http"] },
];

/** متطلبات بيئة تُشرح قبل أن يصطدم بها الم steps لاحقًا برسائلٍ أقل تحديدًا. */
async function preflight() {
  const problems = [];
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
  if (!databaseUrl) {
    problems.push(
      "TEST_DATABASE_URL (أو DATABASE_URL) غير مضبوط — اختبارات PostgreSQL الحقيقية ورحلات التحقق "
      + "واختبارات الأمن كلها تحتاج قاعدة حقيقية. أسرع طريق مُوثَّق:\n"
      + "    docker compose up -d pg18\n"
      + "    TEST_DATABASE_URL=postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable npm run verify:full",
    );
  }
  // Chromium: نستعلم مسار التنفيذ من playwright نفسه — لا تخمينَ للمسارات.
  try {
    const playwright = await import("playwright");
    const executable = playwright.chromium.executablePath();
    if (!existsSync(executable)) {
      problems.push(
        `Chromium غير مثبَّت (${executable}) — رحلات المتصفح واختبارات الأمن تحتاجه:\n`
        + "    npx playwright install --with-deps chromium",
      );
    }
  } catch {
    problems.push("تعذّر قراءة حزمة playwright — شغّل npm ci أولًا.");
  }
  return problems;
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n═══ بوابة كاملة · ${step.name} ═══`);
    const child = spawn(step.command[0], step.command.slice(1), {
      stdio: "inherit",
      cwd: repoRoot,
      env: process.env,
    });
    child.on("error", (error) => resolve({ ...step, ok: false, seconds: 0, error: error.message }));
    child.on("close", (code) => {
      resolve({ ...step, ok: code === 0, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const problems = await preflight();
  if (problems.length > 0) {
    console.error("✘ متطلبات البوابة الكاملة ناقصة — هذا فشل بيئةٍ لا فشل كود:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const results = [];
  for (const step of FULL_GATE_STEPS) {
    const result = await runStep(step);
    results.push(result);
    if (!result.ok) {
      const remaining = FULL_GATE_STEPS.slice(results.length).map((s) => s.name);
      console.error(`\n✘ سقطت البوابة: ${result.name}${result.error ? ` (${result.error})` : ""}`);
      if (remaining.length > 0) console.error(`  البوابات المتبقية (لم تُشغَّل): ${remaining.join("، ")}`);
      console.error("  البوابة الكاملة لا تتجاوز خطوةً ساقطة — أصلح ثم أعد التشغيل من أوله.");
      process.exit(1);
    }
  }
  const totalSeconds = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log(`\n✓ البوابة الكاملة نجحت — ${results.length}/${FULL_GATE_STEPS.length} خطوة في ${(totalSeconds / 60).toFixed(1)} دقيقة.`);
  console.log("  هذا هو العقد نفسه الذي يفرضه CI: نفس البوابات، بالترتيب نفسه، بلا تخطٍّ.");
  process.exit(0);
}
