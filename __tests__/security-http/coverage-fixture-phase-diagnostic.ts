/** Test-only phase observation. No error value, data, SQL, or name is read. */
type Phase = "seed" | "update";
const emitted = new Set<Phase>();
type Write = (line: string) => unknown;

async function phase<T>(name: Phase, operation: () => Promise<T>, write: Write): Promise<T> {
  try { return await operation(); }
  catch (error) {
    // Both names originate exclusively from the two literal calls below.
    // At most one notice per phase per loaded module instance.
    if (!emitted.has(name)) {
      emitted.add(name);
      try { write(`::notice title=Synthetic coverage phase::phase=${name}\n`); } catch { /* Keep the original failure. */ }
    }
    throw error;
  }
}

/** Preserve the existing seed/update order, results and thrown value. */
export async function runCoverageFixturePhases<T>(
  seed: () => Promise<T>,
  update: () => Promise<unknown>,
  write: Write = line => process.stdout.write(line),
): Promise<T> {
  const result = await phase("seed", seed, write);
  await phase("update", update, write);
  return result;
}
