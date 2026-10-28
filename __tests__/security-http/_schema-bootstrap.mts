/* Child-process schema bootstrap for owned built-app databases: the real runtime
   ensureSchema against DATABASE_URL, in its own process (no shared app globals). A
   script file rather than `node -e`, whose CommonJS interop hides named exports on
   some local Node/tsx combinations. */
import { pathToFileURL } from "node:url";
const db = await import(pathToFileURL(`${process.cwd()}/lib/db.ts`).href);
await db.ensureSchema();
await db.resetPoolForTesting();
