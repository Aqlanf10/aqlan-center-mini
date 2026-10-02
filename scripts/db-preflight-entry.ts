import { fileURLToPath } from "node:url";
import { validatePreflightArtifact } from "../lib/preflight-artifact";

async function main() {
  try {
    if (process.env.NODE_PG_FORCE_NATIVE) {
      throw Object.assign(new Error("Native driver is not packaged."), { code: "PACKAGED_NATIVE_UNSUPPORTED" });
    }
    const artifact = await validatePreflightArtifact(fileURLToPath(new URL("../", import.meta.url)));
    // Dynamic import keeps driver initialization after integrity/environment checks.
    const { preflightErrorCode, runPreflightCli } = await import("./db-preflight");
    try { process.exitCode = await runPreflightCli(undefined, undefined, artifact); }
    catch (error) {
      console.error(JSON.stringify({ error: preflightErrorCode(error), complete: false }));
      process.exitCode = 1;
    }
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const safeCode = code === "PACKAGED_NATIVE_UNSUPPORTED" || code === "PREFLIGHT_ARTIFACT_INVALID"
      ? code : "PREFLIGHT_ARTIFACT_LOAD_FAILED";
    console.error(JSON.stringify({ error: safeCode, complete: false }));
    process.exitCode = 1;
  }
}
void main();
