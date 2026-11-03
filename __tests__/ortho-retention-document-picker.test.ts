import { describe, expect, it } from "vitest";
import { editRetentionDocumentIds, readRetentionDocumentPage, readRetentionDocumentResponseJSON,
  retentionDocumentIds, retentionDocumentInventoryURL, RETENTION_DOCUMENT_PAGE_BYTE_LIMIT } from "../lib/ortho-retention-document-picker";
import { hasRetentionNoStore } from "../lib/ortho-retention-transport";

// Synthetic documentary IDs only. These fixtures do not represent clinical
// findings, generated hashes for real sources, or successful server writes.
const scope = { patientId: 71, orthoCaseId: 81, clinicalCaseId: 91 };
const available = (id: number) => ({ id, version: null, kind: "document", state: "available", unavailableReason: null,
  selection: { key: `document_${id}`, kind: "document", id, version: null, contentHash: "a".repeat(64) } });
const unavailable = (id: number) => ({ id, version: null, kind: "document", state: "unavailable", unavailableReason: "document_removed", selection: null });
const inventory = (choices: unknown[] = [available(101), unavailable(102)], nextAfterId: number | null = null) =>
  ({ ok: true, ...scope, kind: "document", state: "available", choices, nextAfterId });
const parse = (raw: unknown, after: number | null = null) => readRetentionDocumentPage(raw, scope, after);
const json = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers });

describe("retention document literal and selection boundary", () => {
  it("requests only the exact existing case inventory and validates every scope ID/cursor", () => {
    expect(retentionDocumentInventoryURL(scope, null)).toBe("/api/ortho/81/case-study/sources?patientId=71&kind=document");
    expect(retentionDocumentInventoryURL(scope, 125)).toBe("/api/ortho/81/case-study/sources?patientId=71&kind=document&afterId=125");
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => retentionDocumentInventoryURL({ ...scope, clinicalCaseId: bad }, null)).toThrow();
      expect(() => retentionDocumentInventoryURL(scope, bad)).toThrow();
    }
  });
  it("retains exact inventory selections and exposes no fabricated title, preview or version", () => {
    const page = parse(inventory()); expect(page.choices[0].selection).toEqual(available(101).selection);
    expect(page.choices[0].version).toBeNull(); expect(page.choices[1].selection).toBeNull();
    expect(Object.keys(page.choices[0]).sort()).toEqual(["id", "kind", "selection", "state", "unavailableReason", "version"]);
  });
  it("rejects foreign scope, wrong kind, extra metadata and malformed selection envelopes", () => {
    for (const raw of [
      { ...inventory(), patientId: 72 }, { ...inventory(), orthoCaseId: 82 }, { ...inventory(), clinicalCaseId: 92 },
      { ...inventory(), kind: "ceph" }, { ...inventory(), ok: false }, { ...inventory(), title: "not in the canonical contract" },
      inventory([{ ...available(101), previewUrl: "/invented" }]), inventory([{ ...available(101), version: 1 }]),
      inventory([{ ...available(101), selection: { ...available(101).selection, id: 102 } }]),
      inventory([{ ...available(101), selection: { ...available(101).selection, key: "document_102" } }]),
      inventory([{ ...available(101), selection: { ...available(101).selection, version: 1 } }]),
      inventory([{ ...available(101), selection: { ...available(101).selection, contentHash: "unverified" } }]),
      inventory([{ ...available(101), selection: null }]), inventory([{ ...unavailable(101), selection: available(101).selection }]),
      inventory([{ ...unavailable(101), unavailableReason: "invented_reason" }]),
    ]) expect(() => parse(raw)).toThrow();
  });
  it("checks the 25-choice cursor contract and binds every row beyond the captured requested cursor", () => {
    const choices = Array.from({ length: 25 }, (_, index) => available(101 + index));
    expect(parse(inventory(choices, 125)).nextAfterId).toBe(125);
    expect(parse(inventory([available(126)], null), 125).choices[0].id).toBe(126);
    for (const raw of [inventory([...choices, available(126)]), inventory([available(101)], 101),
      inventory(choices, 124), inventory([available(102), available(101)]), inventory([available(101), available(101)]),
      { ...inventory([], null), nextAfterId: "125" }, { ...inventory(), state: "restricted" },
    ]) expect(() => parse(raw)).toThrow();
    expect(() => parse(inventory([available(125)]), 125)).toThrow("invalid_retention_document_cursor");
    expect(() => parse(inventory(choices, 125), 125)).toThrow("invalid_retention_document_cursor");
    expect(parse(inventory([]), 125).choices).toEqual([]);
  });
  it("keeps historical correction IDs across empty/restricted/removed/paginated inventories until exact explicit removal", () => {
    const selected = [9, 102], before = [...selected];
    for (const page of [parse(inventory([])), parse({ ...inventory([]), state: "restricted" }), parse(inventory()), parse(inventory([available(201)]), 200)]) {
      expect(editRetentionDocumentIds(selected, page, { type: "add", id: 102 })).toBeNull();
      expect(selected).toEqual(before);
    }
    expect(editRetentionDocumentIds(selected, null, { type: "remove", id: 9 })).toEqual([102]);
    expect(editRetentionDocumentIds(selected, null, { type: "remove", id: 555 })).toBeNull();
    expect(selected).toEqual(before);
    const added = editRetentionDocumentIds(selected, parse(inventory()), { type: "add", id: 101 });
    expect(added).toEqual([9, 102, 101]); expect(added).not.toBe(selected);
  });
  it("rejects missing/unavailable/duplicate choices and never exceeds 30 distinct positive IDs", () => {
    const page = parse(inventory());
    for (const id of [0, -1, 102, 999, NaN]) expect(editRetentionDocumentIds([], page, { type: "add", id })).toBeNull();
    expect(editRetentionDocumentIds([101], page, { type: "add", id: 101 })).toBeNull();
    expect(editRetentionDocumentIds(Array.from({ length: 30 }, (_, i) => i + 1), page, { type: "add", id: 101 })).toBeNull();
    for (const raw of [[1, 1], [0], ["1"], [1.5], Array(1), Array.from({ length: 31 }, (_, i) => i + 1)])
      expect(() => retentionDocumentIds(raw)).toThrow("invalid_retention_document_ids");
  });
  it("admits only the actual no-store directive", () => {
    for (const header of ["no-store", "private, No-Store, max-age=0"]) expect(hasRetentionNoStore(json("{}", { "cache-control": header }))).toBe(true);
    for (const header of ["x=no-store", "no-store-extra", "no-store=token", 'foo="a,no-store,b"', 'foo="x",no-store', "private"])
      expect(hasRetentionNoStore(json("{}", { "cache-control": header }))).toBe(false);
  });
});

describe("bounded document response body", () => {
  it("strictly decodes a bounded streamed JSON body", async () => {
    const raw = inventory(), signal = new AbortController().signal;
    expect(await readRetentionDocumentResponseJSON(json(JSON.stringify(raw)), signal)).toEqual(raw);
    await expect(readRetentionDocumentResponseJSON(json("not json"), signal)).rejects.toThrow();
    await expect(readRetentionDocumentResponseJSON(new Response(null), signal)).rejects.toThrow("retention_document_missing_body");
    await expect(readRetentionDocumentResponseJSON(new Response(new Uint8Array([0xc3, 0x28])), signal)).rejects.toThrow();
  });
  it("enforces declared and actual streaming byte caps even with missing or lying content-length", async () => {
    const signal = new AbortController().signal;
    for (const length of ["-1", "1.5", "999999999999999999999", String(RETENTION_DOCUMENT_PAGE_BYTE_LIMIT + 1)])
      await expect(readRetentionDocumentResponseJSON(json("{}", { "content-length": length }), signal)).rejects.toThrow("retention_document_response_limit");
    const headerCases: Record<string, string>[] = [{}, { "content-length": "2" }];
    for (const headers of headerCases)
      await expect(readRetentionDocumentResponseJSON(json(" ".repeat(RETENTION_DOCUMENT_PAGE_BYTE_LIMIT + 1), headers), signal)).rejects.toThrow("retention_document_response_limit");
  });
  it("cancels and rejects a held body when the lifetime signal is retired", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel() { cancelled = true; } });
    const controller = new AbortController(), pending = readRetentionDocumentResponseJSON(new Response(body), controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow("retention_document_read_retired"); expect(cancelled).toBe(true);
  });
});
