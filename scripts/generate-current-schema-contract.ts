#!/usr/bin/env node
/**
 * npm run schema:contract — يكتب عقد المخطط الحالي الكامل من بناءٍ طازج.
 *
 * هذا العقد **غير** بيان خط الأساس (`schema/baseline-schema-manifest.pg18.json`):
 *
 *   • بيان خط الأساس يصف هجرة 0001 وحدها، وغرضه اعتمادُ قاعدةٍ قائمة على سلسلة
 *     الهجرات (adoption) — فيبقى مجمَّدًا عند ما تصفه تلك الهجرة بالضبط.
 *   • هذا العقد يصف ما يبنيه `ensureSchema()` **اليوم** — أي خط الأساس وكل ما
 *     بعده — وغرضه أن يُثبت أن التثبيت من الصفر يُخرج المخطط كاملًا.
 *
 * فالفرق بينهما ليس خللًا: هو تعريفُهما. وأيّ خلطٍ بينهما يفسد أحد الغرضين.
 *
 *   الاستعمال: DATABASE_URL=postgresql://… npm run schema:contract
 */
import "./load-env.mjs";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../lib/env-contract";
import { withFreshSchema } from "./build-current-schema";

const CONTRACT_PATH = new URL("../schema/current-schema-contract.pg18.json", import.meta.url);

/**
 * (TD-02/TD-REG-008) عقد الإصدار قبل أي عمل: الوجهة «‎.pg18.json» — توليدها على
 * خادمٍ آخر يجعل الملف اسمًا كاذبًا ويُدخل في المراجعة عقدًا لقاعدةٍ لا يفرضها
 * أحد. فُحص الإصدار قبل البناء (لا بعده) ليفشل الطلبُ الخاطئ فورًا وبرسالةٍ
 * تحمل الطريق المحلي الموثَّق (docker compose up -d pg18).
 */
async function assertSchemaContractPostgresMajor(source: string): Promise<void> {
  const client = new Client({ connectionString: source, ssl: false });
  await client.connect();
  try {
    const { rows } = await client.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    const major = postgresMajorFromVersionNum(rows[0]?.server_version_num ?? 0);
    assertPostgresMajorOrThrow(major);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const source = process.env.DATABASE_URL ?? "";
  if (!source.trim()) {
    console.error("خطأ: DATABASE_URL غير مضبوط — التوليد يحتاج خادم PostgreSQL.");
    process.exit(1);
  }
  await assertSchemaContractPostgresMajor(source.trim());
  await withFreshSchema(source, async ({ contract, db }) => {
    const { rows } = await db.getPool().query<{ server_version: string }>("SHOW server_version");
    writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    await db.resetPoolForTesting();
    console.log(`كُتب عقد المخطط الحالي — PostgreSQL ${rows[0]?.server_version ?? "?"}`);
    console.log(`  جداول ${contract.counts.tables} · أعمدة ${contract.counts.columns}`
      + ` · قيود ${contract.counts.constraints} · فهارس ${contract.counts.indexes}`
      + ` · مُشغِّلات ${contract.counts.triggers}`);
  });
  process.exit(0);
}

void main();
