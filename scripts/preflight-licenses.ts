import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { checksumOf } from "../lib/migration-files";

/** Derive third-party notices from the exact modules included by the bundler. */
export async function preflightThirdPartyNotices(projectRoot: string, inputs: string[]) {
  const roots = new Set<string>();
  for (const input of inputs) {
    if (!input.replace(/\\/g, "/").includes("node_modules/")) continue;
    let directory = path.dirname(path.resolve(projectRoot, input));
    while (directory !== path.dirname(directory)) {
      try {
        const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        if (pkg.name && pkg.version) { roots.add(directory); break; }
      } catch { /* A module's nearest package may be above its compiled directory. */ }
      directory = path.dirname(directory);
    }
    if (!roots.has(directory)) throw new Error("Bundled package provenance unavailable.");
  }
  const entries = await Promise.all([...roots].map(async (root) => {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const candidates = (await readdir(root)).filter((name) => /^(?:licen[cs]e(?:$|[._-])|copying)/i.test(name)).sort();
    let text = (await Promise.all(candidates.map((name) => readFile(path.join(root, name), "utf8")))).join("\n");
    if (!text) {
      const readme = await readFile(path.join(root, "README.md"), "utf8");
      const section = /^#{1,6}\s+licen[cs]e[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(readme);
      text = section?.[1]?.trim() ?? "";
    }
    if (!text || !/copyright|permission|redistribution/i.test(text)) throw new Error("Bundled package license text unavailable.");
    return { name: String(pkg.name), version: String(pkg.version), license: String(pkg.license ?? "See notice"),
      licenseSha256: checksumOf(text), text };
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    packages: entries.map(({ text: _text, ...metadata }) => metadata),
    text: entries.map((entry) => `${entry.name}@${entry.version} (${entry.license})\n${"=".repeat(60)}\n${entry.text.trim()}\n`).join("\n"),
  };
}
