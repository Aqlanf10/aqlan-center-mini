import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitCollectionsPaginationControls, type CollectionsNativeEvidenceMember } from "./security-http/_collections-native-evidence";

const prefix = "SYNTHETIC_COLLECTIONS_PAGINATION_CONTROL_V1";
const filenames = ["collections-pagination-old-layout-control.pdf", "collections-pagination-multipage-layout-control.pdf"];
// These signature fixtures test the log transport only, never PDF acceptance.
const members = (): CollectionsNativeEvidenceMember[] => filenames.map(filename => ({
  filename, mime: "application/pdf", bytes: Buffer.from("%PDF-1.4\nsynthetic transport fixture\n%%EOF\n"),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded collections pagination control evidence", () => {
  it("round-trips the two exact buffers under an explicitly non-financial layout-control protocol", () => {
    vi.stubEnv("GITHUB_RUN_ID", "123456");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = members();
    emitCollectionsPaginationControls([...input].reverse());
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(6);
    for (const [index, member] of input.entries()) {
      const begin = `${prefix} BEGIN `;
      expect(lines[index * 3].startsWith(begin)).toBe(true);
      const meta = JSON.parse(lines[index * 3].slice(begin.length));
      expect(meta).toEqual({ scope: "collections-pagination-controls", file: member.filename, mime: "application/pdf",
        bytes: member.bytes.length, sha256: createHash("sha256").update(member.bytes).digest("hex"), chunks: 1,
        runId: "123456", checkoutSha: "a".repeat(40), synthetic: true, acceptance: false, layoutOnly: true,
        control: index === 0 ? "old-layout-negative" : "tall-row-multipage" });
      const chunk = `${prefix} CHUNK ${member.filename} 1/1 `;
      expect(lines[index * 3 + 1].startsWith(chunk)).toBe(true);
      expect(Buffer.from(lines[index * 3 + 1].slice(chunk.length), "base64")).toEqual(member.bytes);
      expect(lines[index * 3 + 2]).toBe(`${prefix} END ${JSON.stringify(meta)}`);
    }
  });

  it("preserves sequence and bytes across bounded log chunks", () => {
    const input = members();
    input[0].bytes = Buffer.from(`%PDF-1.4\n${"x".repeat(9000)}\n%%EOF\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    emitCollectionsPaginationControls(input);
    const lines = log.mock.calls.map(call => String(call[0]));
    const meta = JSON.parse(lines[0].slice(`${prefix} BEGIN `.length));
    expect(meta.chunks).toBeGreaterThan(1);
    const encoded = lines.slice(1, meta.chunks + 1).map((line, index) => {
      const header = `${prefix} CHUNK ${filenames[0]} ${index + 1}/${meta.chunks} `;
      expect(line.startsWith(header)).toBe(true);
      const chunk = line.slice(header.length);
      expect(chunk.length).toBeLessThanOrEqual(4096);
      return chunk;
    }).join("");
    expect(Buffer.from(encoded, "base64")).toEqual(input[0].bytes);
    expect(lines[meta.chunks + 1]).toBe(`${prefix} END ${JSON.stringify(meta)}`);
  });

  it.each([
    ["missing member", (input: CollectionsNativeEvidenceMember[]) => input.pop()],
    ["duplicate name", (input: CollectionsNativeEvidenceMember[]) => { input[1].filename = input[0].filename; }],
    ["unknown name", (input: CollectionsNativeEvidenceMember[]) => { input[1].filename = "unrelated.pdf"; }],
    ["wrong MIME", (input: CollectionsNativeEvidenceMember[]) => { input[1].mime = "image/png"; }],
    ["empty bytes", (input: CollectionsNativeEvidenceMember[]) => { input[1].bytes = Buffer.alloc(0); }],
    ["non-buffer bytes", (input: CollectionsNativeEvidenceMember[]) => { input[1].bytes = "%PDF-1.4 %%EOF" as unknown as Buffer; }],
    ["bad PDF signature", (input: CollectionsNativeEvidenceMember[]) => { input[1].bytes = Buffer.from("not a PDF %%EOF"); }],
    ["missing EOF", (input: CollectionsNativeEvidenceMember[]) => { input[1].bytes = Buffer.from("%PDF-1.4 unfinished"); }],
    ["high-bit PDF magic lookalike", (input: CollectionsNativeEvidenceMember[]) => { input[1].bytes[0] |= 0x80; }],
    ["high-bit EOF lookalike", (input: CollectionsNativeEvidenceMember[]) => {
      const eof = input[1].bytes.lastIndexOf(Buffer.from("%%EOF", "ascii"));
      input[1].bytes[eof] |= 0x80;
    }],
    ["oversized buffer", (input: CollectionsNativeEvidenceMember[]) => { input[1].bytes = Buffer.alloc(2 * 1024 * 1024 + 1); }],
  ] as const)("rejects %s before emitting any frame", (_name, alter) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = members();
    alter(input);
    expect(() => emitCollectionsPaginationControls(input)).toThrow(/Pagination control/);
    expect(log).not.toHaveBeenCalled();
  });

  it("sanitizes provenance instead of logging arbitrary environment text", () => {
    vi.stubEnv("GITHUB_RUN_ID", "unexpected\nvalue");
    vi.stubEnv("GITHUB_SHA", "not-a-checkout");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    emitCollectionsPaginationControls(members());
    const meta = JSON.parse(String(log.mock.calls[0][0]).slice(`${prefix} BEGIN `.length));
    expect(meta.runId).toBe("unavailable");
    expect(meta.checkoutSha).toBe("unavailable");
    expect(log.mock.calls.join("\n")).not.toContain("unexpected");
  });
});
