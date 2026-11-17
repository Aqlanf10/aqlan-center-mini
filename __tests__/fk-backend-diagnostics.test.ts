import { describe, expect, it } from "vitest";
import { safeFkBackendActivity } from "./postgres/_fk-backend-diagnostics";

describe("synthetic FK cleanup diagnostics", () => {
  it("keeps every backend and distinguishes fixture clients from PostgreSQL workers", () => {
    const rows = [
      { pid: 17, state: "active", backend_type: "client backend", application_name: "synthetic-fk-pool", wait_event_type: "Client" },
      { pid: 18, state: "active", backend_type: "autovacuum worker", application_name: "", wait_event_type: null },
      { pid: 19, state: "idle", backend_type: "client backend", application_name: "aqlan-center-mini", wait_event_type: "IO" },
    ];
    expect(safeFkBackendActivity(rows)).toEqual([
      { pid: 17, state: "active", backendType: "client backend", application: "synthetic-fk-pool", waitType: "Client" },
      { pid: 18, state: "active", backendType: "autovacuum worker", application: "other", waitType: null },
      { pid: 19, state: "idle", backendType: "client backend", application: "aqlan-center-mini", waitType: "IO" },
    ]);
  });

  it("redacts unknown metadata without suppressing a live backend", () => {
    const marker = "synthetic-private-marker";
    const result = safeFkBackendActivity([{ pid: 20, state: marker, backend_type: marker, application_name: marker, wait_event_type: marker }]);
    expect(result).toEqual([{ pid: 20, state: "other", backendType: "other", application: "other", waitType: "other" }]);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(safeFkBackendActivity([])).toEqual([]);
  });
});
