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
