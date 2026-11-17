import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/deny-restore-network.mjs", import.meta.url));
const script = fileURLToPath(new URL("../scripts/restore-full.ts", import.meta.url));
const env = { PATH: process.env.PATH, NODE_ENV: "test" as const, NODE_OPTIONS: "" };
const message = "خيار allowNonEmptyTarget معطّل مؤقتًا؛ استخدم هدف استعادة جديدًا ومعزولًا.";

it("installs a subprocess network block before exercising the CLI", () => {
  const probe = spawnSync(process.execPath, ["--import", preload, "-e", "require('node:net').connect({host:'127.0.0.1',port:1})"], { cwd: root, env, encoding: "utf8" });
  expect(probe.status).not.toBe(0);
  expect(probe.stderr).toContain("SYNTHETIC_NETWORK_BLOCKED");
});

it.each([
  { args: ["--allow-non-empty-target"], extraEnv: {} },
  { args: ["synthetic.tar.gz", "--allow-non-empty-target"], extraEnv: {
    DATABASE_URL: "postgres://synthetic@127.0.0.1:1/synthetic", DOCUMENTS_DIR: "/synthetic-stage",
  } },
])("refuses the option before target guard with missing or supplied arguments", ({ args, extraEnv }) => {
  const result = spawnSync(process.execPath, ["--import", preload, "--import", "tsx", script, ...args], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(3);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe(message);
});
