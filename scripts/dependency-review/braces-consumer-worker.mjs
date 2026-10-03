import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOfficialBracesFixture } from "./braces-fixture.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const contract = JSON.parse(readFileSync(new URL("./braces-review-contract.json", import.meta.url), "utf8"));
const provenance = JSON.parse(readFileSync(join(repository, "vendor/braces-provenance.json"), "utf8"));
const [workspace, mode] = process.argv.slice(2);
assert(workspace && ["official", "candidate"].includes(mode), "Expected a consumer workspace and official/candidate mode");
assert.equal(Number(process.versions.node.split(".")[0]), contract.nodeMajor);
const require = createRequire(join(resolve(workspace), "package.json"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const installedIndexes = new Set();

function inventory(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    assert(!entry.isSymbolicLink(), "Unexpected installed candidate symlink");
    return entry.isDirectory() ? inventory(join(directory, entry.name), name + "/") : [name];
  }).sort();
}

const paths = contract.consumerChains.map(chain => {
  let consumerRequire = require;
  const steps = [];
  for (const name of chain) {
    const packageFile = consumerRequire.resolve(name + "/package.json");
    const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
    steps.push({ name, version: pkg.version, packageFile: relative(workspace, packageFile) });
    consumerRequire = createRequire(packageFile);
  }
  const packageFile = consumerRequire.resolve("braces/package.json");
  const directory = dirname(packageFile);
  assert.equal(realpathSync(directory), directory, "Candidate must not be a directory alias/symlink");
  assert.deepEqual(inventory(directory), Object.keys(provenance.patch.source_sha256).sort());
  const hashes = {};
  for (const [name, expected] of Object.entries(provenance.patch.source_sha256)) {
    const path = join(directory, name);
    assert(lstatSync(path).isFile(), "Expected an installed regular file");
    hashes[name] = sha256(readFileSync(path));
    assert.equal(hashes[name], expected, `Candidate hash mismatch: ${name}`);
  }
  installedIndexes.add(consumerRequire.resolve("braces"));
  return { chain, steps, hashes };
});

let official;
try {
  if (mode === "official") {
    official = loadOfficialBracesFixture({ dependencyRequire: require });
    // A fresh, bounded child process substitutes ONLY the independently
    // verified original braces exports. Every other installed dependency and
    // input is identical to candidate mode; no app-installed baseline is used.
    for (const filename of installedIndexes) {
      require.cache[filename] = { id: filename, filename, loaded: true, exports: official.module, children: [], paths: [] };
    }
    assert.doesNotThrow(() => official.module.parse("{".repeat(129) + "a,b" + "}".repeat(129)));
  } else {
    for (const filename of installedIndexes) {
      assert.throws(() => require(filename).compile("{".repeat(4_000) + "a,b" + "}".repeat(4_000)),
        error => error.code === "BRACES_NESTING_LIMIT");
    }
  }

  const globResults = contract.globPatterns.map(pattern => ({
    pattern,
    fastGlobTasks: require("fast-glob").generateTasks([pattern]),
    micromatchExpansion: require("micromatch").braces(pattern, { expand: true }),
  }));
  const config = require("tailwindcss/loadConfig")(join(repository, contract.tailwind.config));
  const boundedConfig = { ...config, content: [{ raw: contract.tailwind.rawHtmlClasses, extension: "html" }] };
  const css = (await require("postcss")([require("tailwindcss")(boundedConfig)])
    .process(contract.tailwind.inputCss, { from: undefined })).css;
  const cssFile = mode + ".css";
  writeFileSync(join(workspace, cssFile), css);
  console.log(JSON.stringify({
    mode,
    bracesSource: mode === "official" ? { kind: "verified-independent-archive", integrity: official.integrity } : { kind: "installed-candidate", version: "3.0.3" },
    installedConsumerPaths: paths,
    installedBracesPaths: [...installedIndexes].map(path => relative(workspace, path)),
    globResults,
    css: { file: cssFile, bytes: Buffer.byteLength(css), sha256: sha256(css) },
    guardResult: mode === "candidate" ? "BRACES_NESTING_LIMIT on every consumer resolution" : "original source accepts depth129",
  }, null, 2));
} finally {
  official?.cleanup();
}
