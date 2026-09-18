/** أنواع بوابة verify:full — التصريح المرافق لسكربت scripts/verify-full.mjs. */

export interface FullGateStep {
  /** اسم الخطوة كما يُعرض في سجل البوابة. */
  name: string;
  /** الأمر كما يُشغَّل: العنصر الأول هو التنفيذي والبقية معاملات. */
  command: string[];
  /** خطوة توليد عقد المخطط: يُستعاد الملف الملتزم بعدها (عين git checkout -- في CI). */
  regeneratesCommittedSchemaContract?: boolean;
}

export declare const FULL_GATE_STEPS: readonly FullGateStep[];

/** الطريق المحلي الموثَّق للبوابة الكاملة — يُختبر عليه قرار البيئة في __tests__. */
export declare const DOCUMENTED_FULL_GATE_SETUP: {
  composeUp: string;
  databaseUrl: string;
  testDatabaseUrl: string;
  command: string;
};

/** فحص متطلبات قاعدة البيئة (ساكن — لا يفتح اتصالًا) — قرار البيئة الموثَّق قابلٌ للاختبار. */
export declare function databasePreflight(
  environment?: Record<string, string | undefined>,
): { problems: string[]; warnings: string[] };
