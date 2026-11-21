import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../proxy";

const root = "https://clinic.test/print/prescription/123";
const synthetic = "SYNTHETIC PRINT ONLY اختبار";
const transports: ReadonlyArray<Record<string, string>> = [{}, { RSC: "1" }];

describe("prescription request boundary", () => {
  it.each(["draft", "items", "diagnosis", "notes"])("refuses %s before App Router page transport", async key => {
    for (const requestHeaders of transports) {
      const request = new NextRequest(`${root}?rx=345&${key}=&${key}=${encodeURIComponent(synthetic)}`, {
        headers: requestHeaders,
      });
      const result = await proxy(request);
      expect(result.status).toBe(404);
      expect(await result.text()).toBe("");
      expect(result.headers.get("location")).toBeNull();
      expect(result.headers.get("x-middleware-next")).toBeNull();
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(JSON.stringify([...result.headers])).not.toContain(encodeURIComponent(synthetic));
    }
  });

  it.each([
    `${root}?rx=345`, `${root}?rx=345&doctorName=synthetic&date=2031-01-05&lang=ar`,
    `${root}?rx=345&rx=345`, "https://clinic.test/print/invoice/456?notes=synthetic",
  ])("preserves existing page-level authority for %s", async url => {
    const result = await proxy(new NextRequest(url));
    expect(result.headers.get("x-middleware-next")).toBe("1");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("content-security-policy")).toContain("'strict-dynamic'");
  });
});
