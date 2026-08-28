import { describe, expect, it } from "vitest";

import { isLocalOrPrivateHost, resolveSsl } from "@/db";

const NO_ENV = {};

describe("isLocalOrPrivateHost", () => {
  it("treats local development hosts as private", () => {
    expect(isLocalOrPrivateHost("localhost")).toBe(true);
    expect(isLocalOrPrivateHost("LOCALHOST")).toBe(true);
    expect(isLocalOrPrivateHost("127.0.0.1")).toBe(true);
    expect(isLocalOrPrivateHost("::1")).toBe(true);
  });

  it("treats Railway private-network hosts as private", () => {
    expect(isLocalOrPrivateHost("postgres.railway.internal")).toBe(true);
    expect(isLocalOrPrivateHost("redis.railway.internal")).toBe(true);
  });

  it("treats public hosts as remote", () => {
    expect(isLocalOrPrivateHost("containers-us-west-1.railway.app")).toBe(false);
    expect(isLocalOrPrivateHost("db.example.com")).toBe(false);
  });
});

describe("resolveSsl", () => {
  it("enables TLS by default for remote hosts (Railway public proxy)", () => {
    const url = new URL(
      "postgresql://postgres:pass@containers-us-west-1.railway.app:6543/railway"
    );
    expect(resolveSsl(url, NO_ENV)).toBe(true);
  });

  it("keeps local development plain by default", () => {
    const url = new URL("postgresql://postgres:pass@localhost:5432/aqlan");
    expect(resolveSsl(url, NO_ENV)).toBe(false);
    const ip = new URL("postgresql://postgres:pass@127.0.0.1:5432/aqlan");
    expect(resolveSsl(ip, NO_ENV)).toBe(false);
  });

  it("keeps Railway private networking plain by default", () => {
    const url = new URL(
      "postgresql://postgres:pass@postgres.railway.internal:5432/railway"
    );
    expect(resolveSsl(url, NO_ENV)).toBe(false);
  });

  it("defers to postgres.js when the URL carries sslmode/ssl explicitly", () => {
    for (
      const raw of [
        "postgresql://u:p@db.example.com:5432/db?sslmode=require",
        "postgresql://u:p@localhost:5432/db?sslmode=require",
        "postgresql://u:p@db.example.com:5432/db?sslmode=disable",
        "postgresql://u:p@db.example.com:5432/db?ssl=true",
      ]
    ) {
      expect(resolveSsl(new URL(raw), NO_ENV)).toBeUndefined();
    }
  });

  it("DATABASE_SSL override wins over everything", () => {
    const remote = new URL("postgresql://u:p@db.example.com:5432/db");
    expect(resolveSsl(remote, { DATABASE_SSL: "false" })).toBe(false);
    const local = new URL("postgresql://u:p@localhost:5432/db");
    expect(resolveSsl(local, { DATABASE_SSL: "true" })).toBe(true);
    expect(resolveSsl(local, { DATABASE_SSL: "verify-full" })).toBe(
      "verify-full"
    );
  });
});
