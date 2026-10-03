import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
import LegacyClinicalVisitPage from "../app/visits/[id]/clinical/page";

describe("legacy visit-page compatibility", () => {
  it("redirects old clinical links to the canonical visit without another record/UI", async () => {
    await expect(LegacyClinicalVisitPage({ params: Promise.resolve({ id: "41" }) })).rejects.toThrow("REDIRECT:/visits/41");
  });
  it.each(["0", "-1", "1/../../login", "https://elsewhere.test", "9007199254740992"])('rejects invalid ID %s', async (id) => {
    await expect(LegacyClinicalVisitPage({ params: Promise.resolve({ id }) })).rejects.toThrow("NOT_FOUND");
  });
});
