import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { emitReceiptProvenanceEvidence, emitReceiptProvenanceFailedPdf, RECEIPT_PROVENANCE_EVIDENCE_FILES, type ReceiptProvenanceEvidenceMember } from "./security-http/_receipt-provenance-evidence";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function members(): ReceiptProvenanceEvidenceMember[] {
  return RECEIPT_PROVENANCE_EVIDENCE_FILES.map(filename => ({ filename,
    mime: filename.endsWith(".pdf") ? "application/pdf" : "image/png",
    // Transport-envelope unit fixtures; actual PDFs/PNGs come only from Chromium in the journey.
    bytes: filename.endsWith(".pdf") ? Buffer.from("%PDF-1.7\nsynthetic-envelope\n%%EOF\n")
      : Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("synthetic-envelope")]),
  }));
}

describe("bounded synthetic receipt-provenance evidence transport", () => {
  it("round-trips only the exact allowlisted buffers with checksums and bounded provenance", () => {
    const calls: string[] = [];
    vi.spyOn(console, "log").mockImplementation(line => { calls.push(String(line)); });
    vi.stubEnv("GITHUB_RUN_ID", "123456789");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    const input = members();
    emitReceiptProvenanceEvidence(input);
    const begin = calls.filter(line => line.includes(" BEGIN "));
    const end = calls.filter(line => line.includes(" END "));
    expect(begin).toHaveLength(10); expect(end).toHaveLength(10);
    for (const [index, member] of input.entries()) {
      const metadata = JSON.parse(begin[index].split(" BEGIN ")[1]);
      expect(metadata).toMatchObject({ scope: "receipt-provenance", file: member.filename,
        mime: member.mime, bytes: member.bytes.length, runId: "123456789", checkoutSha: "a".repeat(40), synthetic: true });
      expect(end[index].split(" END ")[1]).toBe(begin[index].split(" BEGIN ")[1]);
      const frames = calls.filter(line => line.includes(` CHUNK ${member.filename} `));
      expect(frames).toHaveLength(metadata.chunks);
      const decoded = Buffer.from(frames.map((line, chunk) => {
        const parts = line.split(" ");
        expect(parts[3]).toBe(`${chunk + 1}/${frames.length}`);
        expect(parts[4].length).toBeLessThanOrEqual(4096);
        return parts[4];
      }).join(""), "base64");
      expect(decoded).toEqual(member.bytes);
      expect(metadata.sha256).toBe(createHash("sha256").update(decoded).digest("hex"));
    }
  });

  it("emits nothing if any member is missing, duplicated, unknown, malformed or oversized", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const good = members();
    const replaced = (patch: Partial<ReceiptProvenanceEvidenceMember>) => good.map((member, i) => i === 9 ? { ...member, ...patch } : member);
    const invalid = [
      good.slice(1), [...good.slice(0, 9), good[0]],
      replaced({ filename: "../../private.pdf" as ReceiptProvenanceEvidenceMember["filename"] }),
      replaced({ mime: "image/png" }), replaced({ bytes: Buffer.alloc(0) }),
      replaced({ bytes: Buffer.from("%PDF-1.7 missing end") }),
      replaced({ bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }),
      good.map((member, i) => i === 0 ? { ...member, bytes: Buffer.from("not a PNG") } : member),
    ];
    for (const input of invalid) {
      expect(() => emitReceiptProvenanceEvidence(input)).toThrow(/evidence/i);
      expect(output).not.toHaveBeenCalled();
    }
  });

  it("does not leak arbitrary environment text in evidence metadata", () => {
    const calls: string[] = [];
    vi.spyOn(console, "log").mockImplementation(line => { calls.push(String(line)); });
    vi.stubEnv("GITHUB_RUN_ID", "PRIVATE-ENV-TEXT\nINJECTED");
    vi.stubEnv("GITHUB_SHA", "PRIVATE-ENV-TEXT");
    emitReceiptProvenanceEvidence(members());
    expect(calls.join("\n")).not.toContain("PRIVATE-ENV-TEXT");
    expect(calls.join("\n")).not.toContain("INJECTED");
    const metadata = JSON.parse(calls[0].split(" BEGIN ")[1]);
    expect(metadata.runId).toBe("unavailable"); expect(metadata.checkoutSha).toBe("unavailable");
  });

  it("keeps failed native PDFs separately labelled and rejects unbounded diagnostics before logging", () => {
    const calls: string[] = [];
    vi.spyOn(console, "log").mockImplementation(line => { calls.push(String(line)); });
    const bytes = members().find(member => member.mime === "application/pdf")!.bytes;
    expect(() => emitReceiptProvenanceFailedPdf("private" as "original", bytes)).toThrow(/diagnostic/);
    expect(() => emitReceiptProvenanceFailedPdf("original", Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow(/diagnostic/);
    expect(() => emitReceiptProvenanceFailedPdf("original", Buffer.from("not a PDF"))).toThrow(/diagnostic/);
    expect(calls).toEqual([]);
    emitReceiptProvenanceFailedPdf("original", bytes);
    expect(calls.every(line => line.startsWith("SYNTHETIC_RECEIPT_PROVENANCE_DIAGNOSTIC_V1 "))).toBe(true);
    const metadata = JSON.parse(calls[0].split(" BEGIN ")[1]);
    expect(metadata).toMatchObject({ file: "receipt-provenance-original-failed.pdf", synthetic: true,
      diagnosticOnly: true, acceptance: false, bytes: bytes.length });
    expect(metadata.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
