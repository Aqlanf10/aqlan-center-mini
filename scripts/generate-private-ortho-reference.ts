import { readFile } from "node:fs/promises";
import { generatePrivateReference, PrivateReferenceRefused } from "../lib/ortho-private-reference";
import { OPERATOR_LIMITS } from "../lib/ortho-reconciliation-limits";
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ event: "ortho_private_reference_refused", category: "deadline", outcome: "unknown", inspectPrivateJournal: true }));
  process.exit(124);
}, OPERATOR_LIMITS.processMs);
async function main() {
  if (process.argv.length !== 2) throw new PrivateReferenceRefused("config");
  const config = JSON.parse(await readFile(process.env.ORTHO_REFERENCE_CONFIG_FILE ?? "", "utf8"));
  const result = await generatePrivateReference(config, process.env.ORTHO_REFERENCE_OUTPUT_DIR ?? "");
  console.log(JSON.stringify({ event: result.event, digest: result.digest }));
}
main().catch(error => {
  console.error(JSON.stringify({ event: "ortho_private_reference_refused", category: error instanceof PrivateReferenceRefused ? error.category : "generation", inspectPrivateJournal: true }));
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
