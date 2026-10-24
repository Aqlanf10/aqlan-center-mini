// Runs ONE runtime's real startup schema path (ensureSchema) against DATABASE_URL, in its own
// process so the deployed and candidate module graphs never mix. Prints elapsed milliseconds.
// Usage: tsx init.mjs <runtime checkout root>
const root = process.argv[2];
if (!root) throw new Error("runtime root required");
const db = await import(`${root}/lib/db.ts`);
const started = performance.now();
await db.ensureSchema();
const ms = Math.round(performance.now() - started);
await db.resetPoolForTesting?.();
console.log(JSON.stringify({ ms }));
process.exit(0);
