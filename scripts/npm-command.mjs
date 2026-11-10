import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/** Run npm through the current Node runtime; .cmd files cannot be spawned directly on Windows. */
export function npmCommand(args, environment = process.env) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  const candidates = [
    environment.npm_execpath,
    ...(environment[pathKey] ?? "").split(delimiter).filter(Boolean).map((directory) =>
      join(directory.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npm-cli.js")),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  let cli = candidates.find((candidate) => candidate?.endsWith("npm-cli.js") && existsSync(candidate));
  // Match npm's Windows shim: a global upgrade may live outside Node's bundle.
  // npm_execpath already identifies the actual invoking CLI and takes precedence.
  if (cli && cli !== environment.npm_execpath) {
    const prefixScript = join(dirname(cli), "npm-prefix.js");
    if (existsSync(prefixScript)) {
      const prefix = spawnSync(process.execPath, [prefixScript], {
        encoding: "utf8", env: environment, timeout: 10_000, windowsHide: true,
      });
      if (prefix.status === 0 && prefix.stdout.trim()) {
        const globalCli = [
          join(prefix.stdout.trim(), "node_modules", "npm", "bin", "npm-cli.js"),
          join(prefix.stdout.trim(), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        ].find((candidate) => existsSync(candidate));
        if (globalCli) cli = globalCli;
      }
    }
  }
  if (cli) return [process.execPath, cli, ...args];
  // Unix npm is executable; Windows requires the JavaScript entry point above.
  if (process.platform !== "win32") return ["npm", ...args];
  throw new Error("npm-cli.js not found. Install npm or set npm_execpath to its JavaScript entry point.");
}
