import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), rename: mocks.rename,
}));
import { atomicWriteJson } from "../lib/backupVolume";

let directory: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  mocks.rename.mockReset().mockImplementation(actual.rename);
  directory = await mkdtemp(join(tmpdir(), "aqlan-atomic-retry-"));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("atomic JSON replacement", () => {
  it.runIf(process.platform === "win32")("survives a transient Windows sharing denial without deleting the old target", async () => {
    const target = join(directory, "state.json");
    await writeFile(target, JSON.stringify({ previous: true }));
    mocks.rename.mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }));
    await atomicWriteJson(target, { current: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ current: true });
    expect(mocks.rename.mock.calls.length).toBeGreaterThan(1);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it.runIf(process.platform === "win32")("bounds persistent denial and retains the previous JSON while cleaning only its temporary file", async () => {
    const target = join(directory, "state.json");
    await writeFile(target, JSON.stringify({ previous: true }));
    const denied = Object.assign(new Error("persistent denial"), { code: "EACCES" });
    mocks.rename.mockRejectedValue(denied);
    await expect(atomicWriteJson(target, { current: true })).rejects.toBe(denied);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ previous: true });
    expect(mocks.rename.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.rename.mock.calls.length).toBeLessThanOrEqual(10);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("propagates non-sharing failures without retry or loss of the previous JSON", async () => {
    const target = join(directory, "state.json");
    await writeFile(target, JSON.stringify({ previous: true }));
    const missing = Object.assign(new Error("missing source"), { code: "ENOENT" });
    mocks.rename.mockRejectedValue(missing);
    await expect(atomicWriteJson(target, { current: true })).rejects.toBe(missing);
    expect(mocks.rename).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ previous: true });
    expect(await readdir(directory)).toEqual(["state.json"]);
  });
});
