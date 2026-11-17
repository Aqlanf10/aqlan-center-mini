/** Test-only classification for a synthetic coverage fixture failure.
 * This never probes a database or projects arbitrary error text, names, or data. */
import { types } from "node:util";
const ERROR_CODES = new Set(["23503", "23505", "23514", "25P02", "40001", "40P01", "42P01", "42P07", "42703", "42710", "53300", "55P03", "57P01", "08006"]);
const LINEAGE_MESSAGE = "Synthetic coverage lineage was not valid";
const MAX_EMISSIONS = 32;
let emissions = 0;

function ownData(error: unknown, key: "code" | "message"): unknown {
  try {
    if (((typeof error !== "object" || error === null) && typeof error !== "function") || types.isProxy(error)) return undefined;
    const property = Object.getOwnPropertyDescriptor(error, key);
    return property && "value" in property ? property.value : undefined;
  } catch { return undefined; }
}

/** Fixed categories only. An exact message match is an observation, not a cause. */
export function classifyCoverageFixtureFailure(error: unknown): string {
  const code = ownData(error, "code");
  const safeCode = typeof code === "string" && code.length === 5 && ERROR_CODES.has(code) ? code : "other";
  const message = ownData(error, "message");
  const kind = typeof message === "string" && message.length === LINEAGE_MESSAGE.length && message === LINEAGE_MESSAGE ? "lineage_unavailable" : "other";
  return `::notice::synthetic_coverage_fixture kind=${kind} error=${safeCode}`;
}

/** Returns success unchanged; on failure emits a bounded fixed notice and
 * rethrows the original value. No additional query or timer is performed. */
export async function withCoverageFixtureDiagnostics<T>(
  run: () => Promise<T>,
  emit: (line: string) => void = line => console.info(line),
): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (emissions < MAX_EMISSIONS) {
      emissions++;
      try { emit(classifyCoverageFixtureFailure(error)); } catch { /* Never mask the failure. */ }
    }
    throw error;
  }
}
