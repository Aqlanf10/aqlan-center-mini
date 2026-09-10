import { describe, expect, it } from "vitest";

import {
  AQLAN_CENTER_MINI_DATABASE_NAME,
  AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID,
  assertCorrectDatabaseProject,
  databaseUrlForProject,
  databaseProjectScope,
} from "../lib/database-scope";

describe("Railway database project scope", () => {
  it("allows local and CI databases when Railway identity is absent", () => {
    expect(databaseProjectScope({})).toBe("local");
    expect(() => assertCorrectDatabaseProject({})).not.toThrow();
  });

  it("allows the Aqlan Center Mini Railway project", () => {
    const environment = {
      RAILWAY_PROJECT_ID: AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID,
    };

    expect(databaseProjectScope(environment)).toBe("correct-project");
    expect(() => assertCorrectDatabaseProject(environment)).not.toThrow();
  });

  it("blocks Aqlan Center and every other Railway project", () => {
    const environment = {
      RAILWAY_PROJECT_ID: "existing-clinic-project",
    };
    expect(databaseProjectScope(environment)).toBe("wrong-project");
    expect(() => assertCorrectDatabaseProject(environment)).toThrow(/Aqlan Center Mini/);
  });

  it("routes Railway to the dedicated Mini v2 database", () => {
    const result = databaseUrlForProject(
      "postgresql://user:password@postgres.railway.internal:5432/railway?sslmode=disable",
      { RAILWAY_PROJECT_ID: AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID },
    );

    const parsed = new URL(result);
    expect(parsed.pathname).toBe(`/${AQLAN_CENTER_MINI_DATABASE_NAME}`);
    expect(parsed.hostname).toBe("postgres.railway.internal");
    expect(parsed.searchParams.get("sslmode")).toBe("disable");
  });

  it("removes URI SSL overrides when a trusted Railway CA is configured", () => {
    const result = databaseUrlForProject(
      "postgresql://user:password@postgres.railway.internal:5432/railway?sslmode=require&sslrootcert=%2Ftmp%2Fother.crt&sslcert=%2Ftmp%2Fclient.crt&sslkey=%2Ftmp%2Fclient.key&application_name=test",
      {
        RAILWAY_PROJECT_ID: AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID,
        PGSSL_ROOT_CERT_PEM: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      },
    );

    const parsed = new URL(result);
    expect(parsed.pathname).toBe(`/${AQLAN_CENTER_MINI_DATABASE_NAME}`);
    expect(parsed.searchParams.has("sslmode")).toBe(false);
    expect(parsed.searchParams.has("sslrootcert")).toBe(false);
    expect(parsed.searchParams.has("sslcert")).toBe(false);
    expect(parsed.searchParams.has("sslkey")).toBe(false);
    expect(parsed.searchParams.get("application_name")).toBe("test");
  });

  it("never strips sslmode=disable, so the production TLS guard can reject it", () => {
    const result = databaseUrlForProject(
      "postgresql://user:password@postgres.railway.internal:5432/railway?sslmode=disable&sslrootcert=%2Ftmp%2Fother.crt",
      {
        RAILWAY_PROJECT_ID: AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID,
        PGSSL_ROOT_CERT_PEM: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      },
    );

    const parsed = new URL(result);
    expect(parsed.searchParams.get("sslmode")).toBe("disable");
    expect(parsed.searchParams.get("sslrootcert")).toBe("/tmp/other.crt");
  });

  it("does not rewrite disposable local and CI databases", () => {
    const local = "postgresql://localhost/aqlan_center_test";
    expect(databaseUrlForProject(local, {})).toBe(local);
  });
});
