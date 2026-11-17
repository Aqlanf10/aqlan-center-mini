import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("intake browser boundary", () => {
  it.each(["components/patient/PatientIntakeHistory.tsx", "app/portal/page.tsx"])("bundles %s without server-only Node modules", async entry => {
    const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", external: ["next", "next/*", "react", "react/*", "react-dom", "react-dom/*"], logLevel: "silent", metafile: true });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs).not.toContain("lib/portal.ts");
  });
});
