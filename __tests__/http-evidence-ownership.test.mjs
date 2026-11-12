import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { assignEvidence, evidenceOwners, githubOutputs, inventoryFiles, matchingEvidence, normalFiles, root, validateOwners, verifyOwnedEvidence } from "../scripts/dependency-security/http-evidence-ownership.mjs";
const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const job = workflow.match(/^ {2}security_http:\n(?:(?!^ {2}\S)[\s\S])*/m)[0];
const uploadBlocks = job.split(/^ {6}- name: /m).filter(block => block.includes("uses: actions/upload-artifact@v4"));
const nameOf = block => block.match(/^ {10}name: (.+)-\$\{\{ matrix.shard \}\}$/m)[1];
let assignments;
beforeAll(async () => { assignments = await Promise.all([1, 2].map(shard => assignEvidence(shard))); });
describe("HTTP evidence follows the actual installed shard assignment", () => {
  it("gates every required journey upload on its owner and keeps absence an error", () => {
    for (const entry of evidenceOwners.filter(entry => entry.scope === "normal")) {
      const block = uploadBlocks.find(block => nameOf(block) === entry.name);
      assert.ok(block.includes(`if: always() && steps.http_evidence_owners.outputs.${entry.output} == 'true'`), entry.name);
      assert.ok(block.includes(`path: \${{ steps.http_evidence_owners.outputs.${entry.output}_paths }}`), entry.name);
      assert.ok(block.includes("if-no-files-found: error"), entry.name);
    }
    assert.ok(job.includes("id: http_evidence_owners"));
    assert.ok(job.includes("node scripts/dependency-security/http-evidence-ownership.mjs --assign ${{ matrix.shard }}"));
    assert.ok(job.includes("node scripts/dependency-security/http-evidence-ownership.mjs --verify ${{ matrix.shard }}"));
    assert.ok(job.indexOf("--assign") < job.indexOf("Production build for built-app HTTP tests"));
  });
  it("accounts for every upload and preserves the existing common/optional policies", () => {
    assert.deepEqual(uploadBlocks.map(nameOf).sort(), evidenceOwners.map(entry => entry.name).sort());
    for (const entry of evidenceOwners) {
      const block = uploadBlocks.find(block => nameOf(block) === entry.name);
      assert.equal(block.match(/^ {10}include-hidden-files: (.+)$/m)?.[1] ?? null, entry.includeHidden, entry.name);
      assert.equal(block.match(/^ {10}retention-days: (.+)$/m)?.[1] ?? null, entry.retentionDays, entry.name);
    }
    for (const entry of evidenceOwners.filter(entry => entry.scope !== "normal")) {
      const block = uploadBlocks.find(block => nameOf(block) === entry.name);
      assert.ok(block.includes("if: always()"));
      assert.ok(block.includes(`if-no-files-found: ${entry.missing}`));
      for (const pattern of entry.paths) assert.ok(block.includes(pattern));
    }
    assert.deepEqual(evidenceOwners.filter(entry => entry.missing === "ignore").map(entry => entry.name), ["settings-ui-screenshots"]);
  });
  it("assigns every normal test exactly once and retains the full inventory in each runner", () => {
    const all = assignments.flatMap(a => a.files), files = normalFiles();
    assert.equal(new Set(all).size, files.length); assert.deepEqual(all.sort(), files);
    const config = readFileSync(path.join(root, "vitest.config.security.mts"), "utf8");
    for (const file of inventoryFiles) { assert.ok(config.includes(file)); assert.ok(!all.includes(file)); }
    assert.ok(job.includes('INVENTORY_SCHEMA_TEST: "1"'));
    assert.ok(job.includes('run: npm run test:security-http -- --reporter=default --reporter=json --includeTaskLocation --outputFile.json="$RUNNER_TEMP/http-inventory-raw.json"\n'));
  });
  it("assigns each required evidence pattern once to its producing test, including mixed bundles", () => {
    for (const entry of evidenceOwners.filter(entry => entry.scope === "normal")) {
      const partitions = assignments.map(a => a.artifacts.find(artifact => artifact.name === entry.name));
      assert.deepEqual(partitions.flatMap(a => a.paths).sort(), [...entry.paths].sort(), entry.name);
      for (let index = 0; index < 2; index++) for (const producer of partitions[index].producers) {
        assert.ok(assignments[index].files.includes(producer.test));
        assert.ok(!assignments[1 - index].files.includes(producer.test));
      }
    }
    assert.equal(evidenceOwners.find(e => e.name === "hr-workflow-ui").producers.length, 4);
    assert.equal(evidenceOwners.find(e => e.name === "login-reference-ui").producers.length, 2);
  });
  it("does not depend on checkout directory when applying Vitest's partition", async () => {
    const elsewhere = await assignEvidence(1, evidenceOwners, normalFiles(), "/tmp/synthetic-other-checkout");
    assert.deepEqual(elsewhere.files, assignments[0].files);
    assert.deepEqual(elsewhere.artifacts, assignments[0].artifacts);
  });
  it("writes explicit true/false ownership and only that shard's allowlisted paths", () => {
    for (const assignment of assignments) {
      const output = githubOutputs(assignment);
      for (const entry of assignment.artifacts) {
        assert.ok(output.includes(`${entry.output}=${entry.producers.length > 0}\n`));
        assert.ok(output.includes(`${entry.output}_paths<<END_${entry.output}\n${entry.paths.join("\n")}\nEND_${entry.output}\n`));
      }
    }
  });
  it("missing owned evidence fails while absence belonging only to the other shard does not", () => {
    for (const assignment of assignments) {
      assert.doesNotThrow(() => verifyOwnedEvidence(assignment, () => ["synthetic.png"]));
      const pattern = assignment.artifacts.find(entry => entry.paths.length).paths[0];
      assert.throws(() => verifyOwnedEvidence(assignment, candidate => candidate === pattern ? [] : ["synthetic.png"]), /Missing evidence owned/);
      const foreign = assignments[assignment.shard === 1 ? 1 : 0].artifacts.flatMap(a => a.paths).find(p => !assignment.artifacts.some(a => a.paths.includes(p)));
      assert.ok(foreign);
      assert.doesNotThrow(() => verifyOwnedEvidence(assignment, candidate => candidate === foreign ? [] : ["synthetic.png"]));
    }
  });
  it.each(["missing-test", "missing-witness", "missing-path", "duplicate-path", "duplicate-artifact", "ignore", "traversal"])("fails closed on %s ownership drift", kind => {
    const records = structuredClone(evidenceOwners), entry = records.find(e => e.scope === "normal");
    if (kind === "missing-test") entry.producers[0].test = "absent.test.ts";
    if (kind === "missing-witness") entry.producers[0].witness = "SYN-never-a-producer";
    if (kind === "missing-path") entry.producers[0].paths.pop();
    if (kind === "duplicate-path") entry.producers[0].paths.push(entry.producers[0].paths[0]);
    if (kind === "duplicate-artifact") records.push(structuredClone(entry));
    if (kind === "ignore") entry.missing = "ignore";
    if (kind === "traversal") entry.producers[0].paths[0] = ".settings-ui-artifacts/../../secret";
    assert.throws(() => validateOwners(records, normalFiles()));
  });
  it.each([0, 3, NaN])("rejects invalid shard %s", async shard => { await assert.rejects(assignEvidence(shard), /shard must/); });
});
const temporary = mkdtempSync(path.join(tmpdir(), "synthetic-http-evidence-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
it("verifies exact files and basename globs without unrelated files satisfying a missing path", () => {
  mkdirSync(path.join(temporary, ".settings-ui-artifacts"));
  writeFileSync(path.join(temporary, ".settings-ui-artifacts/scene-390.png"), "synthetic");
  assert.deepEqual(matchingEvidence(".settings-ui-artifacts/scene-390.png", temporary), ["scene-390.png"]);
  assert.deepEqual(matchingEvidence(".settings-ui-artifacts/scene-*.png", temporary), ["scene-390.png"]);
  assert.deepEqual(matchingEvidence(".settings-ui-artifacts/absent.png", temporary), []);
  assert.deepEqual(matchingEvidence(".settings-ui-artifacts/scene-*.pdf", temporary), []);
});

it("assigns clinical visit regimen evidence to its actual producer, even when shards change", () => {
  const entry = evidenceOwners.find(e => e.name === "ortho-regimen-defaults-ui");
  const clinical = entry.producers.find(p => p.test === "clinical-visit-ortho-entry-ui.test.ts");
  const adjustment = entry.producers.find(p => p.test === "ortho-adjustment-wire-defaults-ui.test.ts");
  assert.ok(clinical, "clinical visit regimen captures have a separate producer");
  assert.deepEqual([...clinical.paths].sort(), entry.paths.filter(p => p.includes("/clinical-visit-regimen-")).sort());
  assert.deepEqual([...adjustment.paths].sort(), entry.paths.filter(p => p.includes("/ortho-regimen-")).sort());
  assert.equal(clinical.paths.length, 8); assert.equal(adjustment.paths.length, 8);
});
