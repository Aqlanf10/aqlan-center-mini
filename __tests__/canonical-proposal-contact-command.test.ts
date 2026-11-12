import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { parseCanonicalProposalContact: parse } = await import("../lib/canonical-proposal-contact-command");
const valid = { planId: 2, patientId: 1, expectedVersion: "a".repeat(64), note: null };
it("strict manual-contact intent keeps the opaque observation and trimmed bounded note", () => { expect(parse(valid)).toEqual(valid); expect(parse({ ...valid, note: "  تم التواصل  " }).note).toBe("تم التواصل"); });
it.each([null, [], "bad", {}, { ...valid, actor: "owner" }, { ...valid, planId: "2" }, { ...valid, patientId: 0 }, { ...valid, planId: 2147483648 }, { ...valid, patientId: 1.5 }, { ...valid, expectedVersion: [valid.expectedVersion] }, { ...valid, expectedVersion: "A".repeat(64) }, { ...valid, expectedVersion: "a".repeat(63) }, { ...valid, note: [] }, { ...valid, note: {} }, { ...valid, note: true }, { ...valid, note: "ع".repeat(301) }])("refuses malformed or expanded intent %#", body => { expect(() => parse(body)).toThrow("راجع العرض"); });
