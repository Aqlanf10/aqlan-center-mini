import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { readLanguageContract } from "../lib/ortho-language-contract";
const client = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows }) }) as unknown as Client;
const contract = () => ({ name: "synthetic", languages: [{ lanname: "synthetic", handlers: [
  { slot: "call", present: true, identity: "pg_catalog.synthetic()" },
  { slot: "inline", present: false, identity: null }, { slot: "validator", present: false, identity: null },
] }], routines: [{ identity: "pg_catalog.synthetic()", language: "synthetic", namespace: "pg_catalog", definition: "synthetic definition" }] });
describe("language resolution fails closed", () => {
  it.each(["missing", "ambiguous", "missing_handler", "duplicate_routine", "missing_language", "duplicate_slot"])("rejects %s resolution", async defect => {
    const value = contract();
    if (defect === "missing_handler") value.routines = [];
    if (defect === "duplicate_routine") value.routines.push(value.routines[0]);
    if (defect === "missing_language") value.routines[0].language = "unresolved";
    if (defect === "duplicate_slot") value.languages[0].handlers[2].slot = "inline";
    const rows = defect === "missing" ? [] : defect === "ambiguous" ? [{ contract: value }, { contract: value }] : [{ contract: value }];
    await expect(readLanguageContract(client(rows), "123")).rejects.toThrow("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED");
  });
});
