#!/usr/bin/env node
import "./load-env.mjs";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CI_REQUIRED_NPM_MAJOR,
  CLINIC_TIME_ZONE_CONTRACT,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_NPM_RANGE,
  checkDatabaseUrlForGates,
  checkNpmContract,
  checkNodeContract,
} from "../lib/env-contract.ts";
import { isKnownZone, resolveClinicZone } from "../lib/clinicZone.ts";

/**
 * npm run verify:environment — فحص عقد البيئة قبل أي بوابة (TD-02).
 *
 * هذا الفحص **ساكنٌ بالكامل**: لا يفتح قاعدة، ولا يبني، ولا ينزّل شيئًا — يقرأ
 * ما يُعرفه عن البيئة الحالية ويقارنه بالعقد، ويفشل مغلقًا عند أول انجراف.
 * غرضه أن يعرف المطوّر **قبل** فتح PR إن كانت بيئته تخالف ما يفرضه CI، بدل
 * اكتشافه من سقوط البناء.
 *
 * فحوصه (وكلها تخضع لاختبارات __tests__/environment-parity.test.ts):
 *  1. إصدار Node داخل العقد (‎.nvmrc/engines/CI/Docker كلها على 22).
 *  2. إصدار npm داخل نطاق العقد (التثبيت 10.9+، والتدقيق 11).
 *  3. توافق ملفات العقد مع بعضها: engines في package.json و.nvmrc
 *     يطابقان الثوابت الحية — أي إصلاحٍ في مكانٍ ونسْيٍ في الآخر يُكشَف هنا.
 *  4. التوقيت التعاقدي: في CI يجب أن يكون CLINIC_TIME_ZONE=Asia/Aden حرفيًا؛
 *     محليًا يُحلّ إلى قاعدة معروفة (والافتراض Asia/Aden).
 *  5. روابط القواعد آمنة للبوابات: لا إنتاج، لا مضيف Railway، ولا بعيدٌ
 *     غير مصنَّف — انظر checkDatabaseUrlForGates.
 */

const inCi = process.env.CI === "true";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const violations = [];

function fail(rule, message) {
  violations.push({ rule, message });
}

// ── 1) إصدار Node ────────────────────────────────────────────────────────────
const nodeViolation = checkNodeContract(process.version);
if (nodeViolation) fail(nodeViolation.rule, nodeViolation.message);

// ── 2) إصدار npm ─────────────────────────────────────────────────────────────
const npmVersion = spawnSync("npm", ["--version"], { encoding: "utf8" });
if (npmVersion.error || npmVersion.status !== 0) {
  fail("npm.unavailable", "تعذّر استدعاء npm — لا يمكن التحقق من عقد مدير الحزم.");
} else {
  const npmViolation = checkNpmContract((npmVersion.stdout ?? "").trim());
  if (npmViolation) fail(npmViolation.rule, npmViolation.message);
  if (inCi) {
    const major = Number(/^(\d+)\./.exec((npmVersion.stdout ?? "").trim())?.[1] ?? 0);
    if (major !== CI_REQUIRED_NPM_MAJOR) {
      fail("npm.ci-major", `بوابة CI تحتاج npm ${CI_REQUIRED_NPM_MAJOR} (نهاية الـbulk advisory للتدقيق) — الحالي ${major}.`);
    }
  }
}

// ── 3) توافق ملفات العقد مع الثوابت الحية ──────────────────────────────────
const packageJsonPath = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const engines = packageJson.engines ?? {};
if (engines.node !== SUPPORTED_NODE_RANGE) {
  fail("engines.node.drift", `engines.node في package.json («${engines.node ?? "غير موجود"}») لا يطابق العقد الحي «${SUPPORTED_NODE_RANGE}».`);
}
if (engines.npm !== SUPPORTED_NPM_RANGE) {
  fail("engines.npm.drift", `engines.npm في package.json («${engines.npm ?? "غير موجود"}») لا يطابق العقد الحي «${SUPPORTED_NPM_RANGE}».`);
}
const nvmrcPath = new URL("../.nvmrc", import.meta.url);
if (!existsSync(nvmrcPath)) {
  fail("nvmrc.missing", ".nvmrc غير موجود — عقد إصدار Node للمطوّر غير مثبَّت.");
} else {
  const nvmrc = readFileSync(nvmrcPath, "utf8").trim();
  if (!/^\d+(\.\d+)*$/.test(nvmrc)) {
    fail("nvmrc.invalid", `.nvmrc يحتوي «${nvmrc}» — المتوقع رقم إصدار Node (مثل «22»).`);
  } else if (Number(nvmrc.split(".")[0]) !== Number(SUPPORTED_NODE_RANGE.match(/\d+/)[0])) {
    fail("nvmrc.drift", `.nvmrc («${nvmrc}») يخالف العقد «${SUPPORTED_NODE_RANGE}».`);
  }
}

// ── 4) التوقيت التعاقدي ─────────────────────────────────────────────────────
const rawZone = process.env.CLINIC_TIME_ZONE?.trim() ?? "";
if (inCi) {
  if (rawZone !== CLINIC_TIME_ZONE_CONTRACT) {
    fail("clinic-time-zone.ci", `في CI يجب أن يكون CLINIC_TIME_ZONE=${CLINIC_TIME_ZONE_CONTRACT} حرفيًا — الحالي «${rawZone || "غير مضبوط"}».`);
  }
} else if (rawZone && !isKnownZone(rawZone)) {
  fail("clinic-time-zone.unknown", `CLINIC_TIME_ZONE=«${rawZone}» ليست منطقة IANA معروفة — سيُتجاهلها التطبيق ويعود إلى ${CLINIC_TIME_ZONE_CONTRACT}.`);
}
const resolvedZone = resolveClinicZone(rawZone || undefined);

// ── 5) أمان روابط القواعد للبوابات ──────────────────────────────────────────
for (const varName of ["TEST_DATABASE_URL", "DATABASE_URL"]) {
  const raw = process.env[varName];
  if (!raw?.trim()) continue;
  const dbViolation = checkDatabaseUrlForGates(raw, varName, { ci: inCi });
  if (dbViolation) fail(dbViolation.rule, dbViolation.message);
}

// ── الخلاصة ──────────────────────────────────────────────────────────────────
console.log(`عقد البيئة: Node ${process.version} · npm ${(npmVersion.stdout ?? "?").trim()} · التوقيت المحلول ${resolvedZone}${inCi ? " · سياق CI" : " · سياق محلي"}`);
if (violations.length > 0) {
  console.error(`\n✘ فحص عقد البيئة سقط — ${violations.length} انتهاكًا:`);
  for (const violation of violations) {
    console.error(`  [${violation.rule}] ${violation.message}`);
  }
  console.error("\nالعقد الكامل وتعليمات مطابقة البيئة المحلية: docs/ENVIRONMENT_CI_PARITY.md");
  process.exit(1);
}
console.log(`✓ عقد البيئة مستوفى (Node ${SUPPORTED_NODE_RANGE} · npm ${SUPPORTED_NPM_RANGE} · توقيت العيادة ${CLINIC_TIME_ZONE_CONTRACT}).`);
