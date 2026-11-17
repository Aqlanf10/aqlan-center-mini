import originalSetup from "./_global-setup";
import { validateStandaloneWitnessEnvironment } from "./_standalone-restore-witness-guard";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export default async function setup() {
  validateStandaloneWitnessEnvironment(process.env);
  const workspace = await realpath(process.env.GITHUB_WORKSPACE!);
  const server = await realpath(process.env.SYNTHETIC_STANDALONE_SERVER!);
  if (server !== path.join(workspace, ".next/standalone/server.js") || !(await stat(server)).isFile()) {
    throw new Error("The standalone server must be an existing file in this CI workspace.");
  }
  return originalSetup();
}
