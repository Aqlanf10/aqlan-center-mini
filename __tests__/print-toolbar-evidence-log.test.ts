import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { emitPrintToolbarEvidence, type PrintToolbarEvidenceMember } from "./security-http/_print-toolbar-evidence";

const names = [
  "print-toolbar-invoice-screen.png", "print-toolbar-invoice-print.png", "print-toolbar-invoice.pdf",
  "print-toolbar-receipt-screen.png", "print-toolbar-receipt-print.png", "print-toolbar-receipt.pdf",
];
function fixtures(): PrintToolbarEvidenceMember[] {
  return names.map(filename => {
    const pdf = filename.endsWith(".pdf");
    return { filename, mime: pdf ? "application/pdf" : "image/png", bytes: pdf
      ? Buffer.from("%PDF-1.7\n" + "synthetic-test".repeat(400) + "\n%%EOF\n")
      : Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(5000, 42)]) };
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded synthetic print evidence log transport", () => {
  it("frames each exact member with indexed chunks and verifiable size/hash/provenance", () => {
    vi.stubEnv("GITHUB_RUN_ID", "synthetic-run");
    vi.stubEnv("GITHUB_SHA", "synthetic-checkout");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures();
    emitPrintToolbarEvidence([...members].reverse());
    const lines = log.mock.calls.map(call => String(call[0]));
    let cursor = 0;
    for (const member of members) {
      const begin = lines[cursor++];
      expect(begin).toMatch(/^SYNTHETIC_PRINT_EVIDENCE_V1 BEGIN /);
      const metadata = JSON.parse(begin.slice("SYNTHETIC_PRINT_EVIDENCE_V1 BEGIN ".length));
      expect(metadata).toEqual({ scope: "print-toolbar", file: member.filename, mime: member.mime,
        bytes: member.bytes.length, sha256: createHash("sha256").update(member.bytes).digest("hex"),
        chunks: Math.ceil(member.bytes.toString("base64").length / 4096),
        runId: "synthetic-run", checkoutSha: "synthetic-checkout", synthetic: true });
      const chunks: string[] = [];
      for (let index = 1; index <= metadata.chunks; index++) {
        const prefix = `SYNTHETIC_PRINT_EVIDENCE_V1 CHUNK ${member.filename} ${index}/${metadata.chunks} `;
        const line = lines[cursor++];
        expect(line.startsWith(prefix)).toBe(true);
        const chunk = line.slice(prefix.length);
        expect(chunk).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(chunk.length).toBeLessThanOrEqual(4096);
        chunks.push(chunk);
      }
      expect(Buffer.from(chunks.join(""), "base64")).toEqual(member.bytes);
      expect(lines[cursor++]).toBe(`SYNTHETIC_PRINT_EVIDENCE_V1 END ${JSON.stringify(metadata)}`);
    }
    expect(cursor).toBe(lines.length);
  });

  it.each(["missing", "duplicate", "unknown", "mime", "png-size", "pdf-size", "signature", "pdf-eof"])(
    "emits no partial evidence for %s rejection", fault => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const members = fixtures();
      if (fault === "missing") members.pop();
      if (fault === "duplicate") members[5] = members[2];
      if (fault === "unknown") members[5].filename = "unlisted-output.pdf";
      if (fault === "mime") members[5].mime = "image/png";
      if (fault === "png-size") members[4].bytes = Buffer.alloc(1024 * 1024 + 1);
      if (fault === "pdf-size") members[5].bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
      if (fault === "signature") members[4].bytes = Buffer.from("not-a-png");
      if (fault === "pdf-eof") members[5].bytes = Buffer.from("%PDF-1.7\nmissing-final-marker");
      expect(() => emitPrintToolbarEvidence(members)).toThrow(/Synthetic print evidence/);
      expect(log).not.toHaveBeenCalled();
    },
  );
});
