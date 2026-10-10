import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { emitPartyNativeBalanceEvidence, PARTY_NATIVE_BALANCE_EVIDENCE_FILES,
  type PartyNativeBalanceEvidenceMember } from "./security-http/_party-native-balance-evidence";

const prefix = "SYNTHETIC_PARTY_NATIVE_BALANCE_EVIDENCE_V1";
const names = [
  "party-native-balances-desktop-1280.png",
  "party-native-balances-mobile-390.png",
] as const;
const signature = Buffer.from("89504e470d0a1a0a", "hex");
function fixtures(size = 5000): PartyNativeBalanceEvidenceMember[] {
  // Transport unit inputs only: these signature-prefixed bytes are not browser
  // screenshots, are always captured by the console spy and are never evidence.
  return names.map((filename, index) => ({
    filename, mime: "image/png", bytes: Buffer.concat([signature, Buffer.alloc(size - signature.length, 40 + index)]),
  }));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded synthetic party native balance evidence transport", () => {
  it("frames exactly two buffers in allowlist order with indexed 4096-character chunks and SHA-256", () => {
    expect(PARTY_NATIVE_BALANCE_EVIDENCE_FILES).toEqual(names);
    vi.stubEnv("GITHUB_RUN_ID", "123456789");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures();
    emitPartyNativeBalanceEvidence([...members].reverse());
    const lines = log.mock.calls.map(call => String(call[0]));
    let cursor = 0;
    for (const [memberIndex, member] of members.entries()) {
      const begin = lines[cursor++];
      expect(begin.startsWith(`${prefix} BEGIN `)).toBe(true);
      const metadata = JSON.parse(begin.slice(`${prefix} BEGIN `.length));
      expect(metadata).toEqual({
        scope: "party-native-balances", file: member.filename, mime: "image/png", bytes: member.bytes.length,
        sha256: createHash("sha256").update(member.bytes).digest("hex"),
        chunks: Math.ceil(member.bytes.toString("base64").length / 4096),
        runId: "123456789", checkoutSha: "a".repeat(40), synthetic: true,
        scene: "ready-native-badges", viewportWidth: memberIndex === 0 ? 1280 : 390,
        assertionScope: "paired-browser-witness-only",
      });
      const chunks: string[] = [];
      for (let index = 1; index <= metadata.chunks; index++) {
        const marker = `${prefix} CHUNK ${member.filename} ${index}/${metadata.chunks} `;
        const line = lines[cursor++];
        expect(line.startsWith(marker)).toBe(true);
        const chunk = line.slice(marker.length);
        expect(chunk).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(chunk.length).toBeLessThanOrEqual(4096);
        if (index < metadata.chunks) expect(chunk.length).toBe(4096);
        chunks.push(chunk);
      }
      const reconstructed = Buffer.from(chunks.join(""), "base64");
      expect(reconstructed).toEqual(member.bytes);
      expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(metadata.sha256);
      expect(lines[cursor++]).toBe(`${prefix} END ${JSON.stringify(metadata)}`);
    }
    expect(cursor).toBe(lines.length);
  });

  it.each([
    "missing", "extra", "duplicate", "unknown", "traversal", "other-suite", "mime", "non-buffer",
    "empty", "oversize", "signature", "short-signature", "null-member", "sparse", "not-array",
  ])("emits no partial evidence when the last member has a %s fault", fault => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures();
    if (fault === "missing") members.pop();
    if (fault === "extra") members.push(members[0]);
    if (fault === "duplicate") members[1] = members[0];
    if (fault === "unknown") Object.assign(members[1], { filename: "unlisted-output.png" });
    if (fault === "traversal") Object.assign(members[1], { filename: "../party-native-balances-mobile-390.png" });
    if (fault === "other-suite") Object.assign(members[1], { filename: "collections-native-mobile.png" });
    if (fault === "mime") Object.assign(members[1], { mime: "application/pdf" });
    if (fault === "non-buffer") Object.assign(members[1], { bytes: new Uint8Array(signature) });
    if (fault === "empty") members[1].bytes = Buffer.alloc(0);
    if (fault === "oversize") members[1].bytes = Buffer.concat([signature, Buffer.alloc(1024 * 1024 + 1 - signature.length)]);
    if (fault === "signature") members[1].bytes = Buffer.from("not-a-png");
    if (fault === "short-signature") members[1].bytes = signature.subarray(0, 7);
    if (fault === "null-member") members[1] = null as unknown as PartyNativeBalanceEvidenceMember;
    if (fault === "sparse") delete members[1];
    const input = fault === "not-array"
      ? { 0: members[0], 1: members[1], length: 2 } as unknown as PartyNativeBalanceEvidenceMember[]
      : members;
    expect(() => emitPartyNativeBalanceEvidence(input)).toThrow(/Party native balance evidence/);
    expect(log).not.toHaveBeenCalled();
  });

  it("prepares both encodings before emitting, even if the second encoding throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures();
    vi.spyOn(members[1].bytes, "toString").mockImplementation(() => { throw new Error("Synthetic encoding failure"); });
    expect(() => emitPartyNativeBalanceEvidence(members)).toThrow("Synthetic encoding failure");
    expect(log).not.toHaveBeenCalled();
  });

  it("accepts exactly 1 MiB per PNG and 2 MiB total with bounded chunks", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures(1024 * 1024);
    emitPartyNativeBalanceEvidence(members);
    const lines = log.mock.calls.map(call => String(call[0]));
    const begins = lines.filter(line => line.startsWith(`${prefix} BEGIN `))
      .map(line => JSON.parse(line.slice(`${prefix} BEGIN `.length)));
    expect(begins.map(metadata => metadata.bytes)).toEqual([1024 * 1024, 1024 * 1024]);
    expect(begins.reduce((total, metadata) => total + metadata.bytes, 0)).toBe(2 * 1024 * 1024);
    for (const line of lines.filter(line => line.startsWith(`${prefix} CHUNK `))) {
      expect(line.slice(line.lastIndexOf(" ") + 1).length).toBeLessThanOrEqual(4096);
    }
    expect(lines.filter(line => line.startsWith(`${prefix} END `))).toHaveLength(2);
  });

  it.each([
    ["", ""],
    ["9".repeat(25), "f".repeat(41)],
    ["123\n", "a".repeat(40) + "\n"],
    ["untrusted\n".repeat(1000), "secret-not-a-checkout"],
    ["-1", "A".repeat(40)],
  ])("replaces invalid or missing provenance without leaking arbitrary environment text (%#)", (runId, checkoutSha) => {
    vi.stubEnv("GITHUB_RUN_ID", runId);
    vi.stubEnv("GITHUB_SHA", checkoutSha);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    emitPartyNativeBalanceEvidence(fixtures());
    const begins = log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(`${prefix} BEGIN `));
    expect(begins).toHaveLength(2);
    for (const begin of begins) {
      const metadata = JSON.parse(begin.slice(`${prefix} BEGIN `.length));
      expect(metadata.runId).toBe("unavailable");
      expect(metadata.checkoutSha).toBe("unavailable");
      expect(begin.length).toBeLessThan(700);
      expect(begin).not.toContain("secret");
      expect(begin).not.toContain("untrusted");
      expect(begin).not.toContain("\n");
    }
  });

  it.each([40, 64])("admits only bounded numeric run IDs and a %s-character checkout SHA", length => {
    vi.stubEnv("GITHUB_RUN_ID", "9".repeat(24));
    vi.stubEnv("GITHUB_SHA", "f".repeat(length));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    emitPartyNativeBalanceEvidence(fixtures());
    const first = String(log.mock.calls[0][0]);
    const metadata = JSON.parse(first.slice(`${prefix} BEGIN `.length));
    expect(metadata.runId).toBe("9".repeat(24));
    expect(metadata.checkoutSha).toBe("f".repeat(length));
  });
});
