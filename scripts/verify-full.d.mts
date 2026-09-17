/** أنواع بوابة verify:full — التصريح المرافق لسكربت scripts/verify-full.mjs. */

export interface FullGateStep {
  /** اسم الخطوة كما يُعرض في سجل البوابة. */
  name: string;
  /** الأمر كما يُشغَّل: العنصر الأول هو التنفيذي والبقية معاملات. */
  command: string[];
}

export declare const FULL_GATE_STEPS: readonly FullGateStep[];
