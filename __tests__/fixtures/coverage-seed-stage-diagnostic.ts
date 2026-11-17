/** Test-only stage observation. It never receives or inspects the thrown value. */
import { types } from "node:util";
const STAGES = new Set(["case", "clinical", "plan", "service", "invoice", "plan_item", "invoice_item", "source", "revision"]);
const emitted = new Set<string>();
const SOURCE_DETAILS = new Set(["query_exception", "read_exception", "source_missing", "snapshot_missing", "source_and_snapshot_missing"]);
const emittedDetails = new Set<string>();
const emittedAvailability = new Set<string>();

/** Emit at most one fixed notice for each known stage per loaded module instance. */
export function observeCoverageSeedFailure(stage: unknown, write: (line: string) => unknown = line => process.stdout.write(line)): void {
  try {
    if (typeof stage !== "string" || !STAGES.has(stage) || emitted.has(stage)) return;
    emitted.add(stage);
    write(`::notice title=Synthetic coverage seed stage::stage=${stage}\n`);
  } catch { /* A diagnostic must never replace the original failure. */ }
}

/** Only fixed source-observation categories; never receives the source or error. */
export function observeCoverageSourceDetail(detail: unknown, write: (line: string) => unknown = line => process.stdout.write(line)): void {
  try {
    if (typeof detail !== "string" || !SOURCE_DETAILS.has(detail) || emittedDetails.has(detail)) return;
    emittedDetails.add(detail);
    write(`::notice title=Synthetic coverage source detail::detail=${detail}\n`);
  } catch { /* A diagnostic must never replace the original failure. */ }
}

/** Inspect only an own boolean data field; never read sources, values or getters. */
export function observeCoverageSourceAvailability(result: unknown, write: (line: string) => unknown = line => process.stdout.write(line)): void {
  try {
    let availability = "unknown";
    if (typeof result === "object" && result !== null && !types.isProxy(result)) {
      const enabled = Object.getOwnPropertyDescriptor(result, "enabled");
      if (enabled && "value" in enabled) {
        if (enabled.value === false) availability = "disabled";
        else if (enabled.value === true) availability = "enabled_no_source";
      }
    }
    if (emittedAvailability.has(availability)) return;
    emittedAvailability.add(availability);
    write(`::notice title=Synthetic coverage availability::availability=${availability}\n`);
  } catch { /* A diagnostic must never replace the original failure. */ }
}
