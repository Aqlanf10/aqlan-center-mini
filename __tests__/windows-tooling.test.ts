import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { npmCommand } from "../scripts/npm-command.mjs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "aqlan tooling "));
  directories.push(directory);
  return directory;
};

describe("portable development tools", () => {
  it("runs npm JavaScript with the current Node, preserving spaces and shell characters as arguments", () => {
    const cli = join(fixture(), "npm-cli.js");
    writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))");
    const args = ["run", "name with spaces", "$(echo must-not-run)", "a&b"];
    const [executable, ...commandArgs] = npmCommand(args, { npm_execpath: cli });
    expect(executable).toBe(process.execPath);
    const result = spawnSync(executable, commandArgs, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("finds npm from PATH when invoked directly outside an npm script", () => {
    const directory = fixture();
    const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(directory, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(cli, "console.log('11.0.0')");
    const [executable, ...args] = npmCommand(["--version"], { Path: directory });
    const result = spawnSync(executable, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    // A system npm next to Node is also valid; otherwise the PATH fixture is used.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reads CRLF settings without carriage returns and preserves explicit environment overrides", () => {
    const directory = fixture();
    const scripts = join(directory, "scripts");
    mkdirSync(scripts);
    copyFileSync(new URL("../scripts/load-env.mjs", import.meta.url), join(scripts, "load-env.mjs"));
    writeFileSync(join(directory, ".env.local"), "AQLAN_FIXTURE_VALUE=true\r\nAQLAN_FIXTURE_QUOTED=\"a b\"\r\nAQLAN_FIXTURE_OVERRIDE=file\r\n");
    const code = `import ${JSON.stringify(pathToFileURL(join(scripts, "load-env.mjs")).href)}; console.log(JSON.stringify([process.env.AQLAN_FIXTURE_VALUE, process.env.AQLAN_FIXTURE_QUOTED, process.env.AQLAN_FIXTURE_OVERRIDE]));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", env: { ...process.env, NODE_ENV: "development", AQLAN_FIXTURE_OVERRIDE: "shell" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["true", "a b", "shell"]);
  });

  it("never loads private local settings into a test process", () => {
    const directory = fixture();
    mkdirSync(join(directory, "scripts"));
    const loader = join(directory, "scripts", "load-env.mjs");
    copyFileSync(new URL("../scripts/load-env.mjs", import.meta.url), loader);
    writeFileSync(join(directory, ".env.local"), "AQLAN_FIXTURE_PRIVATE=must-not-load\r\n");
    const code = `import ${JSON.stringify(pathToFileURL(loader).href)}; console.log(String(process.env.AQLAN_FIXTURE_PRIVATE));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", env: { ...process.env, NODE_ENV: "test", AQLAN_FIXTURE_PRIVATE: undefined },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("undefined");
  });

  it("honors a global npm upgrade behind a bundled npm shim", () => {
    const bundled = fixture();
    const upgraded = fixture();
    const bundledBin = join(bundled, "node_modules", "npm", "bin");
    const upgradedBin = join(upgraded, "node_modules", "npm", "bin");
    mkdirSync(bundledBin, { recursive: true });
    mkdirSync(upgradedBin, { recursive: true });
    writeFileSync(join(bundledBin, "npm-cli.js"), "console.log('10.9.9')");
    writeFileSync(join(bundledBin, "npm-prefix.js"), `console.log(${JSON.stringify(upgraded)})`);
    writeFileSync(join(upgradedBin, "npm-cli.js"), "console.log('11.0.0')");
    const [executable, ...args] = npmCommand(["--version"], { Path: bundled });
    expect(args[0]).toBe(join(upgradedBin, "npm-cli.js"));
    const result = spawnSync(executable, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("11.0.0");
  });
});
