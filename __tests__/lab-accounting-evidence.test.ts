import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitLabAccountingEvidence, LAB_ACCOUNTING_EVIDENCE_FILES, type LabAccountingEvidenceMember } from "./security-http/_lab-accounting-evidence";

// Transport validation uses signature-marked test bytes only. console.log is
// intercepted throughout: these are never emitted or claimed as browser captures.
const sample = (length = 20) => {
  const bytes = Buffer.alloc(length, 0x61);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  return bytes;
};
const members = (): LabAccountingEvidenceMember[] => LAB_ACCOUNTING_EVIDENCE_FILES.map(filename => ({ filename, mime: "image/png", bytes: sample() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded synthetic lab accounting evidence transport", () => {
  it("emits fixed-order frames with deterministic exact-buffer hashes and bounded chunks", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("GITHUB_RUN_ID", "12345");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    const files = members();
    files[1].bytes = sample(5000);
    emitLabAccountingEvidence([...files].reverse());
    const lines = log.mock.calls.map(call => String(call[0]));
    const prefix = "SYNTHETIC_LAB_ACCOUNTING_EVIDENCE_V1";
    let cursor = 0;
    for (const member of files) {
      const begin = lines[cursor++];
      expect(begin.startsWith(`${prefix} BEGIN `)).toBe(true);
      const metadata = JSON.parse(begin.slice(`${prefix} BEGIN `.length));
      expect(metadata).toMatchObject({ scope: "lab-accounting", file: member.filename, mime: "image/png",
        state: "saved-fx", captureRegion: "visible-saved-fx-area", viewportWidth: member.filename.endsWith("-390.png") ? 390 : 1280,
        bytes: member.bytes.length, sha256: createHash("sha256").update(member.bytes).digest("hex"),
        runId: "12345", checkoutSha: "a".repeat(40), synthetic: true });
      const chunks: string[] = [];
      for (let index = 1; index <= metadata.chunks; index++) {
        const header = `${prefix} CHUNK ${member.filename} ${index}/${metadata.chunks} `;
        expect(lines[cursor].startsWith(header)).toBe(true);
        const chunk = lines[cursor++].slice(header.length);
        expect(chunk.length).toBeLessThanOrEqual(4096);
        chunks.push(chunk);
      }
      expect(Buffer.from(chunks.join(""), "base64")).toEqual(member.bytes);
      expect(lines[cursor++]).toBe(`${prefix} END ${JSON.stringify(metadata)}`);
    }
    expect(cursor).toBe(lines.length);
  });

  it.each(["missing", "extra", "duplicate", "unknown", "mime", "signature", "empty", "oversize", "non-buffer"])(
    "rejects %s without emitting any partial frame", scenario => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const files = members();
      switch (scenario) {
        case "missing": files.pop(); break;
        case "extra": files.push(files[0]); break;
        case "duplicate": files[1] = files[0]; break;
        case "unknown": files[1] = { ...files[1], filename: "arbitrary.png" as LabAccountingEvidenceMember["filename"] }; break;
        case "mime": files[1] = { ...files[1], mime: "text/plain" as "image/png" }; break;
        case "signature": files[1].bytes = Buffer.from("not-a-png"); break;
        case "empty": files[1].bytes = Buffer.alloc(0); break;
        case "oversize": files[1].bytes = sample(1024 * 1024 + 1); break;
        case "non-buffer": files[1].bytes = "89504e470d0a1a0a" as unknown as Buffer; break;
      }
      expect(() => emitLabAccountingEvidence(files)).toThrow();
      expect(log).not.toHaveBeenCalled();
    });

  it("bounds untrusted run identifiers without reflecting their contents", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("GITHUB_RUN_ID", "secret-like-invalid-value");
    vi.stubEnv("GITHUB_SHA", "invalid-checkout-value");
    emitLabAccountingEvidence(members());
    const output = log.mock.calls.map(call => String(call[0])).join("\n");
    expect(output).not.toContain("secret-like-invalid-value");
    expect(output).not.toContain("invalid-checkout-value");
    expect(output).toContain('"runId":"unavailable"');
    expect(output).toContain('"checkoutSha":"unavailable"');
  });
});
