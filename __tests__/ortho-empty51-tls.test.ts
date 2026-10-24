import { describe, expect, it } from "vitest";
import { Client } from "pg";
import type { ConnectionOptions, PeerCertificate } from "node:tls";
import { empty51Tls } from "../lib/ortho-empty51-tls";

function actualTls(host: string) {
  const client = new Client({ host, ssl: empty51Tls(host, "synthetic-ca") });
  return (client as unknown as { connectionParameters: { ssl: ConnectionOptions } }).connectionParameters.ssl;
}
function certificate(subjectaltname: string) {
  return { subjectaltname } as PeerCertificate;
}

describe("empty 0051 operator approved TLS peer identity", () => {
  it("rejects the trusted localhost-name fallback when the approved endpoint is an IP", () => {
    const ssl = actualTls("127.0.0.1");
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe("synthetic-ca");
    expect(ssl.checkServerIdentity!("localhost", certificate("DNS:localhost")))
      .toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
  it.each([
    ["127.0.0.1", "IP Address:127.0.0.1"],
    ["db.example.invalid", "DNS:db.example.invalid"],
  ])("accepts a certificate for the approved %s endpoint", (host, san) => {
    expect(actualTls(host).checkServerIdentity!("ignored-transport-fallback", certificate(san))).toBeUndefined();
  });
  it("rejects a different DNS certificate even if the transport supplies that name", () => {
    expect(actualTls("db.example.invalid").checkServerIdentity!("other.example.invalid", certificate("DNS:other.example.invalid")))
      .toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});
