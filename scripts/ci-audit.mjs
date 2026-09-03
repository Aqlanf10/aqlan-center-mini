#!/usr/bin/env node
/**
 * عدّاء بوابة تدقيق الاعتماديات في CI.
 *
 * القاعدة الدستورية هنا: البناء يفشل للثغرة الحقيقية المؤكدة — لا لانقطاع npm.
 *
 * الخلفية: بعد ترقية npm إلى ١١ (endpoint الإعلانات بالجملة بعد إيقاف القديم)،
 * صار السجل يردّ ٥٠٣ لطلبات خوادم CI أحيانًا — خدمة npm نفسها متعثرة، والاعتماديات
 * سليمة. فالأمر «npm audit» وحده يخرج برمز ١ في الحالين ولا يفرّق. هذا العدّاء:
 *   ١ — يشغّل التدقيق بمهلة قصيرة ويقرار قراره من دالة lib/ci-audit.ts نفسها
 *       التي تختبرها وحدة الاختبارات (مصدرٌ واحد).
 *   ٢ — يعيد المحاولة حتى ٣ مرات بفاصلٍ بينها.
 *   ٣ — يفشل فورًا عند ثغرة مؤكدة moderate فأعلى (البوابة الأمنية قائمة).
 *   ٤ — يمرّر مع تحذيرٍ صريح إن ظل السجل لا يستجيب — عطلُ طرفٍ ثالث ليس ثغرة،
 *       وبناء عيادةٍ عاملة لا يتوقف لأن npm تعطّلت خدمتُها.
 *
 *   node --import tsx scripts/ci-audit.mjs
 */
import { spawnSync } from "node:child_process";
import {
  decideAuditOutcome,
  describeBlockingVulnerabilities,
} from "../lib/ci-audit.ts";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;
const FETCH_TIMEOUT_MS = 120_000;

function runAuditJson() {
  const result = spawnSync(
    "npm",
    [
      "audit",
      "--json",
      "--audit-level=moderate",
      `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
      "--fetch-retries=0",
    ],
    { encoding: "utf8" },
  );
  let report = null;
  try {
    report = JSON.parse(result.stdout ?? "");
  } catch {
    report = null;
  }
  return {
    code: result.status,
    report,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function describeRegistryError({ code, report, stdout, stderr }) {
  const combined = `${stderr}\n${stdout}`;
  const informative = combined
    .split("\n")
    .map((line) => line.trim())
    .find((line) =>
      /npm (warn|error) audit|network timeout|Service Unavailable|Bad Request/i.test(
        line,
      ),
    );
  if (informative) {
    return informative.slice(0, 200);
  }
  if (
    report &&
    typeof report === "object" &&
    typeof report.error === "object" &&
    report.error !== null
  ) {
    return JSON.stringify(report.error).slice(0, 200);
  }
  const firstLine = (stdout || stderr || "").trim().split("\n")[0] ?? "";
  return firstLine.slice(0, 200) || `npm audit خرج بالرمز ${code} بلا مخرجات`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const run = runAuditJson();
    const outcome = decideAuditOutcome(run.report);

    if (outcome === "pass") {
      console.log(
        "بوابة التدقيق خضراء: لا ثغرات بمستوى moderate فأعلى في الاعتماديات.",
      );
      return 0;
    }

    if (outcome === "fail") {
      console.error(
        `بوابة التدقيق حمراء — ثغرات مؤكدة تبلغ العتبة: ${describeBlockingVulnerabilities(run.report)}.`,
      );
      console.error("شغّل «npm audit» محليًا لتفاصيل الثغرات وطرق الترقية.");
      return 1;
    }

    lastError = describeRegistryError(run);
    console.warn(
      `[محاولة ${attempt}/${ATTEMPTS}] لم يكتمل التدقيق لعطلٍ في خدمة سجل npm — ليس ثغرة: ${lastError}`,
    );
    if (attempt < ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.warn(
    `تعذّر إتمام التدقيق بعد ${ATTEMPTS} محاولات — سجل npm لا يستجيب (آخر عطل: ${lastError}).`,
  );
  console.warn(
    "لم تُرصد أي ثغرة، وعطلُ الخدمة في طرف npm لا يوقف بناء العيادة؛ تحقّق يدويًا «npm audit» متى استعاد npm خدمته.",
  );
  return 0;
}

process.exit(await main());
