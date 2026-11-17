/** Test-only stage observation. It never receives or inspects the thrown value. */
const STAGES = new Set(["case", "clinical", "plan", "service", "invoice", "plan_item", "invoice_item", "source", "revision"]);
const emitted = new Set<string>();

/** Emit at most one fixed notice for each known stage per loaded module instance. */
export function observeCoverageSeedFailure(stage: unknown, write: (line: string) => unknown = line => process.stdout.write(line)): void {
  try {
    if (typeof stage !== "string" || !STAGES.has(stage) || emitted.has(stage)) return;
    emitted.add(stage);
    write(`::notice title=Synthetic coverage seed stage::stage=${stage}\n`);
  } catch { /* A diagnostic must never replace the original failure. */ }
}
