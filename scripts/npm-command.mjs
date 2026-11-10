import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Run npm through the current Node runtime; .cmd files cannot be spawned directly on Windows. */
export function npmCommand(args, environment = process.env) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  const candidates = [
    environment.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(environment[pathKey] ?? "").split(delimiter).filter(Boolean).map((directory) =>
      join(directory.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const cli = candidates.find((candidate) => candidate?.endsWith("npm-cli.js") && existsSync(candidate));
  if (cli) return [process.execPath, cli, ...args];
  // Unix npm is executable; Windows requires the JavaScript entry point above.
  if (process.platform !== "win32") return ["npm", ...args];
  throw new Error("npm-cli.js not found. Install npm or set npm_execpath to its JavaScript entry point.");
}
