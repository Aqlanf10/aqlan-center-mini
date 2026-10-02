import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checksumOf } from "./migration-files";

export const PREFLIGHT_SOURCE_FILES = [
  "scripts/db-preflight-entry.ts", "scripts/db-preflight.ts", "lib/db-tls.ts", "lib/db-target.ts",
  "lib/database-scope.ts", "lib/migration-files.ts", "lib/schema-manifest.ts", "lib/schema-preflight.ts",
  "lib/schema-fingerprint.ts", "lib/preflight-artifact.ts", "lib/preflight-provenance.ts",
  "schema/preflight-disclosure.pg18.json",
] as const;

// The bundle embeds these exact build-time source hashes. This binds manifest
// metadata to the integrity-checked bundle without a Git checkout in Production.
declare const __PREFLIGHT_SOURCE_DIGESTS__: Record<string, string> | undefined;
export async function preflightSourceDigests(): Promise<Record<string, string>> {
  if (typeof __PREFLIGHT_SOURCE_DIGESTS__ !== "undefined") return __PREFLIGHT_SOURCE_DIGESTS__;
  return Object.fromEntries(await Promise.all(PREFLIGHT_SOURCE_FILES.map(async (name) => [name,
    checksumOf(await readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8")),
  ])));
}
