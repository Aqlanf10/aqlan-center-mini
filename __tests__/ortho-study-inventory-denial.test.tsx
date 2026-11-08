import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudyOwner } from "../lib/ortho-case-study-owner";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (value: unknown) => [value, () => undefined], useEffect: (effect: () => unknown) => { effect(); } }));
import { SourcePicker } from "../components/OrthoCaseStudy";
afterEach(() => vi.unstubAllGlobals());
describe("fresh source-inventory denial", () => {
  it.each([401, 403])("revokes the current saved-study owner on HTTP %s", async status => {
    const denied = vi.fn(); const owner = { readVersion: 0, active: () => true, denied } as unknown as StudyOwner;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    SourcePicker({ patientId: 19, orthoCaseId: 41, clinicalCaseId: 51, patientName: "Synthetic", ownerKey: "synthetic", owner, confirmDiscard: () => false, locale: "ar", editable: true, onChoose: () => undefined });
    await Promise.resolve(); await Promise.resolve(); expect(denied).toHaveBeenCalledOnce();
  });
  it("does not apply a late denial to an already retired owner", async () => {
    const denied = vi.fn(); const owner = { readVersion: 0, active: () => false, denied } as unknown as StudyOwner;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    SourcePicker({ patientId: 19, orthoCaseId: 41, clinicalCaseId: 51, patientName: "Synthetic", ownerKey: "synthetic", owner, confirmDiscard: () => false, locale: "ar", editable: true, onChoose: () => undefined });
    await Promise.resolve(); await Promise.resolve(); expect(denied).not.toHaveBeenCalled();
  });
});
