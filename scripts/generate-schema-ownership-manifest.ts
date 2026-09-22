import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { candidateOpenFindingsManifest } from "../lib/schema-ownership-open-findings";
import {
  OPEN_FINDINGS_MANIFEST_PATH,
  artifactContainsSensitiveText,
  runSchemaOwnershipCharacterization,
} from "./verify-schema-ownership";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1] || args[1].startsWith("--"))) {
    throw new Error("OPEN_FINDING_CANDIDATE_CLI: allowed arguments are exactly --output <path>.");
  }
  const output = resolve(args.length === 0
    ? join(tmpdir(), `schema-ownership-open-findings.${Date.now()}-${process.pid}.candidate.json`)
    : args[1]);
  if (output.toLowerCase() === resolve(OPEN_FINDINGS_MANIFEST_PATH).toLowerCase()) {
    throw new Error("OPEN_FINDING_CANDIDATE_CLI: cannot overwrite the committed reviewed manifest.");
  }
  const report = await runSchemaOwnershipCharacterization(process.env, { candidateOnly: true });
  const candidate = candidateOpenFindingsManifest(report.comparison);
  const serialized = JSON.stringify(candidate, null, 2) + "\n";
  if (artifactContainsSensitiveText(serialized)) {
    throw new Error("OPEN_FINDING_CANDIDATE_REDACTION: sensitive connection text detected.");
  }
  // Exclusive creation also blocks aliases or symlinks to the existing reviewed file.
  await writeFile(output, serialized, { encoding: "utf8", flag: "wx" });
  console.log(`Candidate open-findings manifest written: ${output}`);
  console.log(`Review required for ${candidate.findings.length} raw differences; the committed manifest was not changed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
