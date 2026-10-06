// Bounded synthetic images only. Invoked inside --network=none containers.
// Never starts the application, opens a database, or reads environment secrets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
const [rootArg, lockFile, officialFiles, kind] = process.argv.slice(2);
assert(rootArg && lockFile && officialFiles && ["glibc", "alpine-musl"].includes(kind));
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(Number(process.versions.node.split(".")[0]), 22);
const root = realpathSync(rootArg);
const require = createRequire(join(root, "package.json"));
const lock = JSON.parse(readFileSync(lockFile, "utf8"));
const official = JSON.parse(readFileSync(officialFiles, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const runtime = process.report.getReport().header;
if (kind === "glibc") assert(runtime.glibcVersionRuntime);
else {
  assert.equal(runtime.glibcVersionRuntime, undefined);
  assert.match(readFileSync("/etc/os-release", "utf8"), /^ID=alpine$/m);
  assert.equal(process.getuid(), 1001, "Actual runner verification uses its unprivileged application UID");
}
function packageRoot(entry, expectedName) {
  let current = dirname(realpathSync(entry));
  for (;;) {
    const file = join(current, "package.json");
    let pkg;
    try { pkg = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (pkg?.name === expectedName) return { directory: current, pkg };
    const parent = dirname(current);
    assert.notEqual(parent, current, "Package identity not found: " + expectedName);
    current = parent;
  }
}
const sharpEntry = require.resolve("sharp");
assert(sharpEntry.startsWith(root + "/"));
const sharpPackage = packageRoot(sharpEntry, "sharp");
assert.equal(sharpPackage.pkg.version, "0.35.5");
assert.equal(lock.packages["node_modules/sharp"].version, "0.35.5");
const sharp = require(sharpEntry);
assert.equal(sharp.versions.sharp, "0.35.5");
assert.equal(sharp.versions.vips, "8.18.7");
assert.equal(sharp.versions.rsvg, "2.63.2");
const platform = kind === "glibc" ? "linux-x64" : "linuxmusl-x64";
const nativeName = "@img/sharp-" + platform;
const nativePackage = packageRoot(require.resolve(nativeName + "/sharp.node"), nativeName);
assert.equal(nativePackage.pkg.version, "0.35.5");
const libvipsName = "@img/sharp-libvips-" + platform;
const libvipsDirectory = join(root, "node_modules", libvipsName);
assert.equal(JSON.parse(readFileSync(join(libvipsDirectory, "package.json"), "utf8")).version, "1.3.4");
const shippedFiles = {};
function inspect(name, directory) {
  assert(directory.startsWith(root + "/"));
  assert(official[name]);
  const inventory = {};
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const file = join(current, entry.name);
      assert(!entry.isSymbolicLink(), "Unexpected shipped native package symlink");
      if (entry.isDirectory()) walk(file);
      else {
        assert(lstatSync(file).isFile());
        const path = relative(directory, file);
        assert(Object.hasOwn(official[name], path), "Unrecognized shipped sharp-family file: " + name + "/" + path);
        inventory[path] = hash(readFileSync(file));
        assert.equal(inventory[path], official[name][path], "Shipped native byte mismatch: " + name + "/" + path);
      }
    }
  }
  walk(directory);
  assert(Object.keys(inventory).length > 0);
  shippedFiles[name] = inventory;
}
inspect("sharp", sharpPackage.directory);
inspect(nativeName, nativePackage.directory);
inspect(libvipsName, libvipsDirectory);
const nativeModules = Object.keys(require.cache).filter(path => path.endsWith(".node") && /sharp/.test(path));
assert.equal(nativeModules.length, 1);
assert(nativeModules[0].startsWith(nativePackage.directory + "/"));
assert.equal(nativeModules[0], join(nativePackage.directory, "lib", "sharp-" + platform + "-0.35.5.node"));
const tests = [];
const image = { create: { width: 8, height: 6, channels: 3, background: { r: 255, g: 0, b: 0 } } };
for (const format of ["png", "jpeg", "webp"]) {
  const buffer = await sharp(image)[format](format === "webp" ? { lossless: true } : {}).timeout({ seconds: 5 }).toBuffer();
  const result = await sharp(buffer, { limitInputPixels: 48 }).resize(4, 3).removeAlpha().raw().timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 4);
  assert.equal(result.info.height, 3);
  assert.equal(result.info.channels, 3);
  for (let i = 0; i < result.data.length; i += 3) {
    assert(result.data[i] >= 245 && result.data[i + 1] <= 10 && result.data[i + 2] <= 10, "Unexpected bounded image colors");
  }
  tests.push({ format, source: "synthetic 8x6 red rectangle", width: 4, height: 3, outputSha256: hash(buffer) });
}
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#ff0000"/></svg>');
const decodedSvg = await sharp(svg, { limitInputPixels: 48 }).removeAlpha().raw().timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
assert.equal(decodedSvg.info.width, 8);
assert.equal(decodedSvg.info.height, 6);
assert.equal(decodedSvg.info.channels, 3);
for (let i = 0; i < decodedSvg.data.length; i += 3)
  assert.deepEqual([...decodedSvg.data.subarray(i, i + 3)], [255, 0, 0]);
tests.push({ format: "svg", source: "fixed local synthetic rectangle; no external resources", width: 8, height: 6 });
// Test the actual locked Next image path without HTTP, application startup,
// credentials, user images or network access.
const { imageOptimizer } = require("next/dist/server/image-optimizer");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config");
assert.equal(imageConfigDefault.dangerouslyAllowSVG, false);
const nextConfig = {
  images: imageConfigDefault,
  experimental: { imgOptConcurrency: 1, imgOptOperationCache: false, imgOptMaxInputPixels: 48, imgOptSequentialRead: true, imgOptTimeoutInSeconds: 5 },
};
const params = { href: "/synthetic.png", width: 4, quality: 75, mimeType: "image/webp" };
const png = await sharp(image).png().toBuffer();
const optimized = await imageOptimizer({ buffer: png, etag: "synthetic-png", cacheControl: "no-store" }, params, nextConfig, { silent: true });
assert.equal(optimized.error, undefined);
assert.equal(optimized.contentType, "image/webp");
const metadata = await sharp(optimized.buffer, { limitInputPixels: 48 }).metadata();
assert.equal(metadata.width, 4); assert.equal(metadata.height, 3);
await assert.rejects(
  imageOptimizer({ buffer: svg, etag: "synthetic-svg", cacheControl: "no-store" }, { ...params, href: "/synthetic.svg" }, nextConfig, { silent: true }),
  error => error.statusCode === 400 && /image type is not allowed/.test(error.message),
);
tests.push({ format: "next/image", result: "actual Next16.3.8 PNG optimizer and default SVG denial passed" });
console.log(JSON.stringify({
  status: "bounded image and native provenance proof passed",
  kind, node: process.version, platform: process.platform, arch: process.arch, uid: process.getuid(),
  libc: runtime.glibcVersionRuntime || "musl; /etc/os-release is Alpine",
  versions: sharp.versions, resolvedSharp: relative(root, sharpEntry),
  loadedNativeModules: nativeModules.map(path => relative(root, path)),
  shippedFiles, tests,
  limitations: ["No public HTTP or application authorization proof", "No exploit payload or vulnerability baseline execution", "No Production or Railway access"],
}, null, 2));
