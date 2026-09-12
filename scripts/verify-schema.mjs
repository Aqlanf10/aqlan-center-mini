#!/usr/bin/env node
import "./load-env.mjs";
import { readFileSync } from "node:fs";

/**
 * هل يُبنى المخطط من الصفر — كاملًا؟
 *
 * السؤال الذي لا يجيب عنه أي اختبار وحدة، ولا تكشفه أي قاعدة قائمة: الجدول الناقص
 * موجودٌ فيها من قبل، فيمرّ الخلل صامتًا إلى أن يُنشأ نظام جديد — عند مزوّد جديد، أو
 * في بيئة تجربة، أو يوم استعادة من نسخة احتياطية بعد كارثة. وأسوأ وقت لاكتشاف أن
 * برنامجك لا يُثبَّت هو اليوم الذي تحتاج فيه إلى تثبيته.
 *
 * كان المقيس به قائمةَ واحدٍ وثلاثين اسمًا مكتوبةً باليد في هذا الملف، والمخطط
 * الحقيقي ستةٌ وخمسون جدولًا — أي أن خمسةً وعشرين جدولًا (المخزون وحركاته وإجراءات
 * الزيارة وبنود الخطط والوصفات ومستندات المريض ونسب المواد وحدود الدخول وجداول
 * السيفالومتري…) كانت خارج الحراسة تمامًا: يسقط أيٌّ منها من `ensureSchema` فيبقى
 * الفحص أخضر. وقائمةُ أسماءٍ باليد تتخلّف دائمًا، لأن من يضيف جدولًا لا يمرّ بها.
 *
 * فالمقيس به الآن عقدٌ مولَّد من المخطط نفسه:
 *   `schema/current-schema-contract.pg18.json` ← `npm run schema:contract`
 * والشرط: العقد ⊆ الواقع. كل جدولٍ وعمودٍ ونوعٍ وقابليةِ عدمٍ ومفتاحٍ وفرادةٍ وقيدِ
 * فحصٍ وإشارةٍ وفهرسٍ ومُشغِّلٍ في العقد يجب أن يوجد في القاعدة المبنية من الصفر.
 * والزيادة في الواقع لا تُسقط الفحص — إنما تُعلَن، فهي دعوةٌ لإعادة التوليد لا خطأ.
 *
 * وهذا العقد **غير** بيان خط الأساس: ذاك يصف هجرة 0001 وحدها لغرض اعتماد قاعدةٍ
 * قائمة على سلسلة الهجرات، وهذا يصف ما يبنيه الكود اليوم. الفرق بينهما (جدول
 * material_rate_history من هجرة 0004، وحرّاس 0005) تعريفٌ لا خلل.
 *
 *   الاستعمال: DATABASE_URL=postgresql://… node scripts/verify-schema.mjs
 */

const source = process.env.DATABASE_URL ?? "";
if (!source.trim()) {
  console.error("خطأ: DATABASE_URL غير مضبوط.");
  process.exit(1);
}

const CONTRACT_PATH = new URL("../schema/current-schema-contract.pg18.json", import.meta.url);
let contract;
try {
  contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
} catch (error) {
  console.error(`خطأ: تعذّر قراءة عقد المخطط — ${error.message}`);
  console.error("ولّده بـ: npm run schema:contract");
  process.exit(1);
}

let failed = false;
const problems = [];
const fail = (line) => { problems.push(line); failed = true; };

const { withFreshSchema } = await import("./build-current-schema.ts");

await withFreshSchema(source, async ({ contract: actual, db }) => {
  console.log(`بُني المخطط من الصفر — PostgreSQL ${actual.generatedOnServerVersion}`);
  if (actual.generatedOnServerVersion !== contract.generatedOnServerVersion) {
    console.log(`  ملحوظة: العقد وُلّد على ${contract.generatedOnServerVersion}`);
  }

  const sameSet = (want, got) => want.length === got.length && want.every((v, i) => v === got[i]);
  const key = (cols) => cols.join(",");

  for (const [table, want] of Object.entries(contract.tables)) {
    const got = actual.tables[table];
    if (!got) { fail(`جدول ناقص: ${table}`); continue; }

    for (const [column, spec] of Object.entries(want.columns)) {
      const actualColumn = got.columns[column];
      if (!actualColumn) { fail(`عمود ناقص: ${table}.${column}`); continue; }
      if (actualColumn.type !== spec.type) {
        fail(`نوع مخالف: ${table}.${column} — العقد ${spec.type} والواقع ${actualColumn.type}`);
      }
      if (actualColumn.nullable !== spec.nullable) {
        fail(`قابلية العدم مخالفة: ${table}.${column} — العقد ${spec.nullable ? "يقبل" : "لا يقبل"}`
          + ` والواقع ${actualColumn.nullable ? "يقبل" : "لا يقبل"}`);
      }
    }

    if (want.primaryKey.length > 0 && !sameSet(want.primaryKey, got.primaryKey)) {
      fail(`مفتاح أساسي مخالف: ${table} — العقد (${key(want.primaryKey)}) والواقع (${key(got.primaryKey)})`);
    }
    const gotUnique = new Set(got.unique.map(key));
    for (const cols of want.unique) {
      if (!gotUnique.has(key(cols))) fail(`قيد فرادة ناقص: ${table} (${key(cols)})`);
    }
    const gotChecks = new Set(got.checks);
    for (const name of want.checks) {
      if (!gotChecks.has(name)) fail(`قيد فحص ناقص: ${table}.${name}`);
    }
    const gotFks = new Set(got.foreignKeys.map((fk) => `${key(fk.columns)}→${fk.refTable}(${key(fk.refColumns)})`));
    for (const fk of want.foreignKeys) {
      const signature = `${key(fk.columns)}→${fk.refTable}(${key(fk.refColumns)})`;
      if (!gotFks.has(signature)) fail(`إشارة ناقصة: ${table} ${signature}`);
    }
    for (const [name, spec] of Object.entries(want.indexes)) {
      const actualIndex = got.indexes[name];
      if (!actualIndex) { fail(`فهرس ناقص: ${table}.${name}`); continue; }
      if (!sameSet(spec.columns, actualIndex.columns)) {
        fail(`أعمدة فهرس مخالفة: ${table}.${name} — العقد (${key(spec.columns)})`
          + ` والواقع (${key(actualIndex.columns)})`);
      }
      if (actualIndex.unique !== spec.unique) fail(`فرادة فهرس مخالفة: ${table}.${name}`);
    }
    for (const [name, spec] of Object.entries(want.triggers)) {
      const actualTrigger = got.triggers[name];
      if (!actualTrigger) { fail(`مُشغِّل ناقص: ${table}.${name}`); continue; }
      if (actualTrigger.timing !== spec.timing || key(actualTrigger.events) !== key(spec.events)) {
        fail(`مُشغِّل مخالف: ${table}.${name} — العقد ${spec.timing} ${key(spec.events)}`
          + ` والواقع ${actualTrigger.timing} ${key(actualTrigger.events)}`);
      }
    }
  }

  const extraTables = Object.keys(actual.tables).filter((name) => !contract.tables[name]);
  if (extraTables.length > 0) {
    console.log(`  زيادة على العقد (أعِد التوليد): ${extraTables.join("، ")}`);
  }

  if (failed) {
    console.error(`\nانحراف المخطط عن عقده — ${problems.length} بندًا:`);
    for (const line of problems) console.error(`  ✗ ${line}`);
  } else {
    console.log(`كل ما في العقد موجود: ${contract.counts.tables} جدولًا · ${contract.counts.columns} عمودًا`
      + ` · ${contract.counts.constraints} قيدًا · ${contract.counts.indexes} فهرسًا`
      + ` · ${contract.counts.triggers} مُشغِّلًا.`);
  }

  /*
   * ثم يُعاد الإنشاء على قاعدة **فيها بيانات**.
   *
   * هذه هي الحالة التي فاتت الفحص الأول: كلّ ما يُصفّي أو يُحوّل صفوفًا قائمة —
   * مواءمة العدّادات مثلًا — لا يُنفَّذ أصلًا على قاعدة فارغة، فيمرّ الخطأ ويظهر
   * أول مرة على قاعدة الإنتاج وحدها. وقد وقع هذا فعلًا.
   */
  const seeded = await db.createPatient({
    fullName: "فحص المخطط", phone: null, altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });
  await db.openShift({ openedBy: "فحص", opening: { YER: 0, SAR: 0, USD: 0 } });
  await db.recordPayment({
    patientId: seeded.id, invoiceId: null, kind: "payment", amountMinor: 100,
    currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
    note: null, createdBy: "فحص",
  });

  // إقلاعٌ ثانٍ فوق بيانات قائمة — كما يحدث في كل نشرة إنتاج.
  db.schemaReadyReset();
  await db.ensureSchema();
  const after = await db.createPatient({
    fullName: "بعد الإقلاع الثاني", phone: null, altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });
  if (after.patientNumber === seeded.patientNumber) {
    console.error("✗ خلل: تكرّر رقم الملف بعد إعادة الإقلاع.");
    failed = true;
  } else {
    console.log(`أُعيد الإنشاء فوق بيانات قائمة: ${seeded.patientNumber} ← ${after.patientNumber}.`);
  }
}).catch((error) => {
  console.error(`فشل إنشاء المخطط: ${error.message}`);
  failed = true;
});

process.exit(failed ? 1 : 0);
