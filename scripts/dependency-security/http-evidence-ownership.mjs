import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer } from "vitest/node";

export const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const inventoryFiles = ["inventory-procurement-http-ui.test.ts", "inventory-supplier-operational-http-ui.test.ts", "inventory-reference-closed-http-ui.test.ts"];
export const evidenceOwners = JSON.parse(readFileSync(new URL("./http-evidence-owners.json", import.meta.url), "utf8"));
export function normalFiles(projectRoot = root) {
  return readdirSync(path.join(projectRoot, "__tests__/security-http"), { recursive: true }).map(String)
    .filter(file => file.endsWith(".test.ts") && !inventoryFiles.includes(file)).sort();
}
export function validateOwners(records, files, source = file => readFileSync(path.join(root, "__tests__/security-http", file), "utf8")) {
  const names = new Set(), outputs = new Set();
  for (const entry of records) {
    if (names.has(entry.name) || outputs.has(entry.output) || !/^evidence_[a-z_]+$/.test(entry.output)) throw new Error("Duplicate or invalid artifact ownership identity");
    names.add(entry.name); outputs.add(entry.output);
    if (entry.scope === "common") {
      if (!["http-security-test-locations", "http-inventory-test-locations"].includes(entry.name) || entry.producers.length || entry.missing !== "error") throw new Error("Invalid common report exception");
      continue;
    }
    if (entry.scope === "preexisting-optional-shared") {
      if (entry.name !== "settings-ui-screenshots" || entry.missing !== "ignore" || entry.paths.join() !== ".settings-ui-artifacts/" || entry.producers.length) throw new Error("Invalid pre-existing optional exception");
      continue;
    }
    if (entry.scope !== "normal" || entry.missing !== "error" || !entry.producers.length) throw new Error("Required evidence has no owner");
    const paths = [];
    for (const producer of entry.producers) {
      if (!files.includes(producer.test) || !producer.witness || !source(producer.test).includes(producer.witness) || !producer.paths.length) throw new Error(`Missing test or producer witness for ${entry.name}`);
      for (const pattern of producer.paths) {
        if (!/^(\.settings-ui-artifacts\/|\/tmp\/(?:hr-evidence|leadership-hub-evidence|lab-backlog-evidence)\/)/.test(pattern)
          || pattern.includes("..") || /[\r\n\0]/.test(pattern) || path.dirname(pattern).includes("*")) throw new Error(`Unsafe evidence pattern for ${entry.name}`);
        paths.push(pattern);
      }
    }
    if (new Set(paths).size !== paths.length || JSON.stringify(paths.sort()) !== JSON.stringify([...entry.paths].sort())) throw new Error(`Incomplete or duplicate evidence paths for ${entry.name}`);
  }
}
export async function assignEvidence(shard, records = evidenceOwners, files = normalFiles(), projectRoot = root) {
  if (![1, 2].includes(shard)) throw new Error("HTTP shard must be 1 or 2");
  validateOwners(records, files);
  const specifications = files.map(file => ({ moduleId: path.resolve(projectRoot, "__tests__/security-http", file) }));
  const selected = await new BaseSequencer({ config: { root: projectRoot, shard: { index: shard, count: 2 } } }).shard(specifications);
  const selectedNames = new Set(selected.map(file => path.relative(path.join(projectRoot, "__tests__/security-http"), file.moduleId)));
  return { shard, files: [...selectedNames].sort(), artifacts: records.filter(entry => entry.scope === "normal").map(entry => ({
    name: entry.name, output: entry.output,
    producers: entry.producers.filter(producer => selectedNames.has(producer.test)),
    paths: entry.producers.filter(producer => selectedNames.has(producer.test)).flatMap(producer => producer.paths),
  })) };
}
export function githubOutputs(assignment) {
  return assignment.artifacts.map(entry => `${entry.output}=${entry.producers.length > 0}\n${entry.output}_paths<<END_${entry.output}\n${entry.paths.join("\n")}\nEND_${entry.output}\n`).join("");
}
export function matchingEvidence(pattern, projectRoot = root) {
  const absolute = path.isAbsolute(pattern) ? pattern : path.resolve(projectRoot, pattern);
  const directory = path.dirname(absolute), filename = path.basename(absolute);
  if (!existsSync(directory)) return [];
  const expression = new RegExp(`^${filename.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return readdirSync(directory).filter(name => expression.test(name) && lstatSync(path.join(directory, name)).isFile());
}
export function verifyOwnedEvidence(assignment, matches = matchingEvidence) {
  const absent = assignment.artifacts.flatMap(entry => entry.paths.filter(pattern => !matches(pattern).length).map(pattern => `${entry.name}: ${pattern}`));
  if (absent.length) throw new Error(`Missing evidence owned by HTTP shard ${assignment.shard}:\n${absent.join("\n")}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !["--assign", "--verify"].includes(args[0]) || !/^[12]$/.test(args[1])) throw new Error("Usage: http-evidence-ownership.mjs --assign|--verify 1|2");
  const assignment = await assignEvidence(Number(args[1]));
  if (args[0] === "--verify") verifyOwnedEvidence(assignment);
  else {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required for ownership assignment");
    appendFileSync(process.env.GITHUB_OUTPUT, githubOutputs(assignment));
  }
  console.log(JSON.stringify({ shard: assignment.shard, files: assignment.files.length, artifactGroups: assignment.artifacts.filter(entry => entry.paths.length).length, evidencePatterns: assignment.artifacts.reduce((sum, entry) => sum + entry.paths.length, 0), action: args[0] }));
}
