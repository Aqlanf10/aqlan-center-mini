import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const workflow = readFileSync(join(__dirname, "../.github/workflows/finance-candidate-image.yml"), "utf8");
const stepBlocks = workflow.split(/^ {6}- /m).slice(1);
const sourceName = "Verify exact candidate source";
const buildName = "Build unchanged candidate Docker image";
const smokeName = "Verify artifacts offline without application startup";
const proofName = "Record allowlisted image proof";
const imageTag = "aqlan-finance-candidate:verification";
const imageId = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

// Extract the actual workflow bodies, fail closed on layout drift, and execute
// them with synthetic inputs. These tests are not a substitute for Docker CI.
function shellBody(name: string): string {
  const steps = stepBlocks.filter((block) => block.startsWith(`name: ${name}\n`));
  expect(steps).toHaveLength(1);
  const literal = steps[0].match(/^ {8}run: \|\n([\s\S]*)$/m);
  expect(literal).not.toBeNull();
  const lines = literal![1].trimEnd().split("\n");
  expect(lines.every((line) => line.startsWith("          ") || line === "")).toBe(true);
  return lines.map((line) => line.slice(10)).join("\n") + "\n";
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aqlan-image-workflow-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  return { root, repo, output: join(root, "output"), summary: join(root, "summary"), calls: join(root, "calls") };
}

function runShell(name: string, cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", shellBody(name)], {
    cwd, encoding: "utf8", timeout: 5_000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, ...env },
  });
}

function outputIfPresent(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function committedFixture() {
  const f = fixture();
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: f.repo, encoding: "utf8", timeout: 5_000,
      env: { NODE_ENV: "test", PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  writeFileSync(join(f.repo, "Dockerfile"), "FROM synthetic-only\n");
  writeFileSync(join(f.repo, ".dockerignore"), "synthetic-exclusion\n");
  git("add", ".");
  git("-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic image source");
  return { ...f, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}

function dockerFixture() {
  const f = fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = ${JSON.stringify(f.calls)};
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
const count = fs.readFileSync(calls, "utf8").trim().split("\\n").length;
if (process.env.FAIL_COMMAND === args[0] || process.env.FAIL_RUN_NUMBER === String(count)) process.exit(42);
if (args[0] === "image") console.log(process.env.FAKE_IMAGE_ID || ${JSON.stringify(imageId)});
`);
  chmodSync(docker, 0o755);
  return { ...f, env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: f.output },
    commands: () => outputIfPresent(f.calls).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("candidate workflow scope and source binding", () => {
  it("checks the original PR allowlist and two exact push branches without privileged or publishing triggers", () => {
    expect(workflow).toContain("  pull_request:\n    branches: [main]\n    types: [opened, synchronize, reopened, ready_for_review, edited]");
    for (const guard of [
      "github.repository == 'Aqlanf10/aqlan-center-mini'",
      "github.event.pull_request.base.ref == 'main'",
      "github.event.pull_request.head.repo.full_name == 'Aqlanf10/aqlan-center-mini'",
      "github.event.pull_request.head.ref == 'integration/finance-candidate-20261022'",
    ]) expect(workflow).toContain(guard);
    expect(workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1]).toBe(
      "  pull_request:\n    branches: [main]\n    types: [opened, synchronize, reopened, ready_for_review, edited]\n"
      + "  push:\n    branches: [feat/dot-combined-staging-20261024, feat/dot-staging-green-composition-20261025]\n");
    expect(workflow).toContain("EXPECTED_HEAD: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain("permissions:\n  contents: read\n");
    expect(workflow).toContain("group: finance-candidate-image-${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: true");
    expect(workflow).toContain("runs-on: ubuntu-latest\n    timeout-minutes: 45");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}\n          fetch-depth: 1\n          persist-credentials: false");
    expect(workflow.match(/uses: .+/g)).toEqual(["uses: actions/checkout@v7"]);
    expect(workflow).not.toMatch(/pull_request_target|workflow_dispatch|workflow_run|paths:|paths-ignore:|secrets\.|vars\.|environment:|services:|continue-on-error|always\(\)|upload-artifact|docker (?:push|login)|--(?:secret|env|env-file|volume|mount|privileged|publish)\b/);
  });

  const candidateRef = "refs/heads/feat/dot-combined-staging-20261024";
  const greenCandidateRef = "refs/heads/feat/dot-staging-green-composition-20261025";
  const repository = "Aqlanf10/aqlan-center-mini";
  const originalHeads = ["integration/finance-candidate-20261022", "feat/finance-synthetic-verification-20261023",
    "feat/finance-reviewed-composition-20261023", "feat/finance-completed-work-20261023"];
  function eventContext(eventName: string, ref = candidateRef, head = originalHeads[0], base = "main", headRepository = repository, ownerRepository = repository) {
    return { repository: ownerRepository, event_name: eventName, ref, sha: "a".repeat(40), event: { pull_request: {
      number: eventName === "pull_request" ? 451 : null, base: { ref: base },
      // GitHub missing expression values are empty; preserve that behavior in the synthetic context.
      head: { ref: head, repo: { full_name: headRepository }, sha: eventName === "pull_request" ? "b".repeat(40) : "" },
    } } };
  }
  const cases = [
    { name: "exact candidate push", github: eventContext("push"), allowed: true },
    { name: "exact green composition push", github: eventContext("push", greenCandidateRef), allowed: true },
    ...["refs/heads/main", "refs/heads/feat/other", `${candidateRef}-extra`, `${greenCandidateRef}-extra`, "refs/tags/feat/dot-combined-staging-20261024", "refs/tags/feat/dot-staging-green-composition-20261025"]
      .map(ref => ({ name: `reject push ${ref}`, github: eventContext("push", ref), allowed: false })),
    { name: "reject foreign repository push", github: eventContext("push", candidateRef, originalHeads[0], "main", repository, "other/fork"), allowed: false },
    { name: "reject foreign repository green composition push", github: eventContext("push", greenCandidateRef, originalHeads[0], "main", repository, "other/fork"), allowed: false },
    { name: "reject green composition PR to main", github: eventContext("pull_request", "refs/pull/475/merge", "feat/dot-staging-green-composition-20261025"), allowed: false },
    { name: "reject green composition workflow dispatch", github: eventContext("workflow_dispatch", greenCandidateRef), allowed: false },
    ...originalHeads.map(head => ({ name: `retain original PR ${head}`, github: eventContext("pull_request", "refs/pull/451/merge", head), allowed: true })),
    { name: "reject new candidate PR to main", github: eventContext("pull_request", "refs/pull/999/merge", "feat/dot-combined-staging-20261024"), allowed: false },
    { name: "reject feature-base PR", github: eventContext("pull_request", "refs/pull/999/merge", originalHeads[0], "feat/finance-completed-work-20261023"), allowed: false },
    { name: "reject foreign PR head", github: eventContext("pull_request", "refs/pull/999/merge", originalHeads[0], "main", "other/fork"), allowed: false },
    { name: "reject workflow dispatch", github: eventContext("workflow_dispatch"), allowed: false },
  ];
  it.each(cases)("evaluates the actual job gate: $name", ({ github, allowed }) => {
    const expression = workflow.match(/^ {4}if: >-\n([\s\S]*?)^ {4}runs-on:/m)?.[1];
    expect(expression).toBeTruthy();
    expect(runInNewContext(expression!, { github }, { timeout: 1_000 })).toBe(allowed);
  });
  it.each([
    { eventName: "push", ref: candidateRef },
    { eventName: "push", ref: greenCandidateRef },
    { eventName: "pull_request", ref: "refs/pull/451/merge" },
  ])("binds checkout and verification to the exact $eventName source SHA on $ref", ({ eventName, ref }) => {
    const github = eventContext(eventName, ref);
    const checkout = workflow.match(/^ {10}ref: \$\{\{ (.+) \}\}/m)?.[1];
    const expected = workflow.match(/^ {10}EXPECTED_HEAD: \$\{\{ (.+) \}\}/m)?.[1];
    expect(checkout).toBe("github.event.pull_request.head.sha || github.sha");
    expect(expected).toBe(checkout);
    expect(runInNewContext(checkout!, { github }, { timeout: 1_000 })).toBe((eventName === "push" ? "a" : "b").repeat(40));
  });

  it.each([sourceName, buildName, smokeName, proofName])("has valid fail-closed Bash: %s", (name) => {
    const shell = shellBody(name);
    expect(shell.startsWith("set -euo pipefail\n")).toBe(true);
    expect(spawnSync("bash", ["-n"], { input: shell, encoding: "utf8" }).status).toBe(0);
  });

  it("binds four allowlisted source identifiers to the exact clean checkout", () => {
    const f = committedFixture();
    const result = runShell(sourceName, f.repo, { EXPECTED_HEAD: f.head, GITHUB_OUTPUT: f.output });
    expect(result.status, result.stderr).toBe(0);
    const digest = (name: string) => createHash("sha256").update(readFileSync(join(f.repo, name))).digest("hex");
    expect(readFileSync(f.output, "utf8")).toBe(`sha=${f.head}\ntree=${f.tree}\ndockerfile=${digest("Dockerfile")}\ndockerignore=${digest(".dockerignore")}\n`);
  });

  it.each(["b".repeat(40), "not-a-sha", `abc\nforged=metadata`])("rejects wrong or malformed head: %s", (head) => {
    const f = committedFixture();
    expect(runShell(sourceName, f.repo, { EXPECTED_HEAD: head, GITHUB_OUTPUT: f.output }).status).not.toBe(0);
    expect(outputIfPresent(f.output)).toBe("");
  });

  it.each(["Dockerfile", "untracked-input"])("rejects changed build source: %s", (file) => {
    const f = committedFixture();
    writeFileSync(join(f.repo, file), "unexpected build input\n");
    expect(runShell(sourceName, f.repo, { EXPECTED_HEAD: f.head, GITHUB_OUTPUT: f.output }).status).not.toBe(0);
    expect(outputIfPresent(f.output)).toBe("");
  });
});

describe("actual Docker command contract with a synthetic command double", () => {
  it("builds the unchanged Dockerfile and records only a validated local image ID", () => {
    const f = dockerFixture();
    const result = runShell(buildName, f.repo, f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(f.commands()).toEqual([
      ["build", "--progress=plain", "--file", "Dockerfile", "--tag", imageTag, "."],
      ["image", "inspect", imageTag, "--format", "{{.Id}}"],
    ]);
    expect(readFileSync(f.output, "utf8")).toBe(`image_id=${imageId}\n`);
  });

  it("does not inspect or emit image proof after a failed Docker build", () => {
    const f = dockerFixture();
    expect(runShell(buildName, f.repo, { ...f.env, FAIL_COMMAND: "build" }).status).toBe(42);
    expect(f.commands()).toHaveLength(1);
    expect(outputIfPresent(f.output)).toBe("");
  });

  it("rejects malformed inspect output instead of forwarding arbitrary metadata", () => {
    const f = dockerFixture();
    expect(runShell(buildName, f.repo, { ...f.env, FAKE_IMAGE_ID: "synthetic-private-configuration" }).status).not.toBe(0);
    expect(outputIfPresent(f.output)).toBe("");
  });

  it("applies all isolation controls to every smoke command without starting the app", () => {
    const f = dockerFixture();
    const result = runShell(smokeName, f.repo, f.env);
    expect(result.status, result.stderr).toBe(0);
    const commands = f.commands();
    expect(commands).toHaveLength(3);
    const prefix = ["run", "--rm", "--network", "none", "--read-only", "--user", "1001:1001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", imageTag];
    for (const command of commands) expect(command.slice(0, prefix.length)).toEqual(prefix);
    expect(commands[0][prefix.length]).toBe("-e");
    expect(commands[0]).toHaveLength(prefix.length + 2);
    expect(commands[1].slice(prefix.length)).toEqual(["--check", "/app/server.js"]);
    expect(commands[2].slice(prefix.length)).toEqual(["/app/preflight/runner/run.mjs", "--help"]);
  });

  it.each([1, 2, 3])("stops immediately when smoke command %i fails", (number) => {
    const f = dockerFixture();
    expect(runShell(smokeName, f.repo, { ...f.env, FAIL_RUN_NUMBER: String(number) }).status).toBe(42);
    expect(f.commands()).toHaveLength(number);
  });
});

describe("offline image assertions execute the embedded Node payload", () => {
  const payload = shellBody(smokeName).match(/:verification -e '([\s\S]*?)\n'\n/);
  // The expression above is intentionally strict about the closing quote after
  // de-indentation. Changing the shell requires updating this extractor too.
  function runPayload(change: { node?: string; uid?: number; missing?: string; tests?: boolean; manifestMajor?: number } = {}) {
    expect(payload).not.toBeNull();
    runInNewContext(payload![1], {
      require: (name: string) => {
        if (name === "node:assert/strict") return assert;
        if (name === "node:fs") return {
          existsSync: (path: string) => path === "/app/__tests__" ? Boolean(change.tests) : path !== change.missing,
          readFileSync: (path: string, encoding: string) => {
            assert.equal(path, "/app/preflight/manifest.json");
            assert.equal(encoding, "utf8");
            return JSON.stringify({ nodeMajor: change.manifestMajor ?? 22 });
          },
        };
        throw new Error(`Unexpected import: ${name}`);
      },
      process: { versions: { node: change.node ?? "22.0.0" }, getuid: () => change.uid ?? 1001 },
      console: { log: () => {} },
    }, { timeout: 1_000 });
  }

  it("accepts only the supported non-root packaged layout", () => expect(() => runPayload()).not.toThrow());
  it.each([
    { node: "20.0.0" }, { uid: 0 }, { manifestMajor: 20 }, { tests: true },
    ...["/app/server.js", "/app/.next/static", "/app/preflight/runner/run.mjs", "/app/preflight/manifest.json"].map((missing) => ({ missing })),
  ])("rejects an invalid image invariant: %j", (change) => expect(() => runPayload(change)).toThrow());
});

describe("success summary contains only allowlisted synthetic proof metadata", () => {
  const proof = { SOURCE_SHA: "b".repeat(40), SOURCE_TREE: "c".repeat(40), DOCKERFILE_SHA256: "d".repeat(64), DOCKERIGNORE_SHA256: "e".repeat(64), IMAGE_ID: imageId };

  it("records source and image identity with honest verification limits", () => {
    const f = fixture();
    const result = runShell(proofName, f.repo, { ...proof, GITHUB_STEP_SUMMARY: f.summary, SYNTHETIC_PRIVATE_VALUE: "must-not-appear" });
    expect(result.status, result.stderr).toBe(0);
    const summary = readFileSync(f.summary, "utf8");
    for (const value of Object.values(proof)) expect(summary).toContain(value);
    expect(summary).toContain("Local image ID (not a registry digest)");
    expect(summary).toContain("No application startup, deployed database access, image publication, or Production verification.");
    expect(summary).not.toContain("must-not-appear");
    expect(summary.trim().split(/\n\n/)).toHaveLength(7);
  });

  it.each(Object.keys(proof))("rejects malformed %s before any summary is written", (key) => {
    const f = fixture();
    expect(runShell(proofName, f.repo, { ...proof, [key]: "injected\nmetadata", GITHUB_STEP_SUMMARY: f.summary }).status).not.toBe(0);
    expect(outputIfPresent(f.summary)).toBe("");
  });
});
