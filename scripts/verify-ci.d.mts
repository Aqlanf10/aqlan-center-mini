import type { Journey } from "./verify-ci-journeys.d.mts";

export interface JourneyResult extends Journey {
  status: "PASS" | "FAIL" | "SKIP";
  seconds: number;
  code: number | null;
}
export declare function runJourneys(
  journeys: Journey[],
  options?: { postgresAvailable?: boolean },
): Promise<JourneyResult[]>;
export declare function summarize(results: JourneyResult[]): number;

/**
 * (تصحيح مراجعة المالك لـTD-02) هل خادم PostgreSQL متاح للرحلات؟ — يُقرأ من
 * DATABASE_URL (رابط الصيانة) حصرًا لا من رابط اختبار التكامل. مُصدَّر ليُختبر
 * عليه قرار البيئة الموثَّق.
 */
export declare function postgresAvailableFromEnv(
  environment?: Record<string, string | undefined>,
): boolean;
