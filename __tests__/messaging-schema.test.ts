import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGING_CHANNELS_SQL } from "../lib/messaging-schema";

describe("(MSG-1) messaging channels schema", () => {
  it("keeps migration 0025 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0025_messaging_channels.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(MESSAGING_CHANNELS_SQL.trim());
  });
});
