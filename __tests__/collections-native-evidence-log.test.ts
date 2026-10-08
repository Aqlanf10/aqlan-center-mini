import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { emitCollectionsNativeEvidence, type CollectionsNativeEvidenceMember } from "./security-http/_collections-native-evidence";

const prefix = "SYNTHETIC_COLLECTIONS_NATIVE_EVIDENCE_V1";
const names = [
  "collections-native-screen.png", "collections-native-print.png", "collections-native.pdf",
  "collections-native-filtered-screen.png", "collections-native-filtered-print.png", "collections-native-filtered.pdf",
  "collections-native-mobile.png",
];
function fixtures(): CollectionsNativeEvidenceMember[] {
  return names.map(filename => {
    const pdf = filename.endsWith(".pdf");
    return { filename, mime: pdf ? "application/pdf" : "image/png", bytes: pdf
      ? Buffer.from("%PDF-1.7\n" + "synthetic-test".repeat(400) + "\n%%EOF\n")
      : Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(5000, 42)]) };
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded synthetic native-currency evidence transport", () => {
  it("frames seven exact buffers with ordered indexed chunks, hashes and bounded provenance", () => {
    vi.stubEnv("GITHUB_RUN_ID", "123456789");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures();
    emitCollectionsNativeEvidence([...members].reverse());
    const lines = log.mock.calls.map(call => String(call[0]));
    let cursor = 0;
    for (const member of members) {
      const begin = lines[cursor++];
      expect(begin.startsWith(`${prefix} BEGIN `)).toBe(true);
      const metadata = JSON.parse(begin.slice(`${prefix} BEGIN `.length));
      expect(metadata).toEqual({ scope: "collections-native", file: member.filename, mime: member.mime,
        bytes: member.bytes.length, sha256: createHash("sha256").update(member.bytes).digest("hex"),
        chunks: Math.ceil(member.bytes.toString("base64").length / 4096),
        runId: "123456789", checkoutSha: "a".repeat(40), synthetic: true });
      const chunks: string[] = [];
      for (let index = 1; index <= metadata.chunks; index++) {
        const marker = `${prefix} CHUNK ${member.filename} ${index}/${metadata.chunks} `;
        const line = lines[cursor++];
        expect(line.startsWith(marker)).toBe(true);
        const chunk = line.slice(marker.length);
        expect(chunk).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(chunk.length).toBeLessThanOrEqual(4096);
        chunks.push(chunk);
      }
      expect(Buffer.from(chunks.join(""), "base64")).toEqual(member.bytes);
      expect(lines[cursor++]).toBe(`${prefix} END ${JSON.stringify(metadata)}`);
    }
    expect(cursor).toBe(lines.length);
  });

  it.each(["missing", "duplicate", "unknown", "mime", "empty", "png-size", "pdf-size", "signature", "pdf-eof"])(
    "emits no partial evidence for %s rejection", fault => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const members = fixtures();
      if (fault === "missing") members.pop();
      if (fault === "duplicate") members[5] = members[2];
      if (fault === "unknown") members[5].filename = "unlisted-output.pdf";
      if (fault === "mime") members[5].mime = "image/png";
      if (fault === "empty") members[5].bytes = Buffer.alloc(0);
      if (fault === "png-size") members[4].bytes = Buffer.alloc(1024 * 1024 + 1);
      if (fault === "pdf-size") members[5].bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
      if (fault === "signature") members[4].bytes = Buffer.from("not-a-png");
      if (fault === "pdf-eof") members[5].bytes = Buffer.from("%PDF-1.7\nmissing-final-marker");
      expect(() => emitCollectionsNativeEvidence(members)).toThrow(/Synthetic collections evidence/);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("never includes arbitrary environment text in provenance", () => {
    vi.stubEnv("GITHUB_RUN_ID", "untrusted\n".repeat(1000));
    vi.stubEnv("GITHUB_SHA", "secret-not-a-checkout");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    emitCollectionsNativeEvidence(fixtures());
    const first = String(log.mock.calls[0][0]);
    expect(first).toContain('"runId":"unavailable","checkoutSha":"unavailable"');
    expect(first.length).toBeLessThan(500);
    expect(first).not.toContain("secret");
    expect(first).not.toContain("untrusted");
  });
});
