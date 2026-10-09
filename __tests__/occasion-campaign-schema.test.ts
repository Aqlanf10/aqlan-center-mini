import { describe, expect, it } from "vitest";
import { OCCASION_CAMPAIGN_SCHEMA_SQL } from "../lib/occasion-campaign-schema";

/** Source assertions only. These do not prove PostgreSQL syntax, constraints or concurrency. */
describe("unregistered occasion queue schema contract", () => {
  it("declares authorization/request replay, durable batches, recipients and attempts", () => {
    for (const table of ["occasion_campaigns", "occasion_campaign_send_requests", "occasion_campaign_batches",
      "occasion_campaign_recipients", "occasion_campaign_attempts"]) {
      expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("PRIMARY KEY(actor, request_key)");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("UNIQUE(campaign_id, endpoint)");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("UNIQUE(campaign_id, request_key)");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("ON occasion_campaign_recipients(campaign_id) WHERE state='claimed'");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("FOREIGN KEY(campaign_id, authorization_id)");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("FOREIGN KEY (id, campaign_id, current_attempt_id)");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Batch lease identity is immutable.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Send request replay evidence is immutable.");
  });
  it("retains immutable authorization and receipt evidence rather than allowing reset-to-queued", () => {
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Authorized campaign fields are immutable.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Provider receipt evidence cannot be erased or replaced.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Uncertainty cannot authorize a retry.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Prior acceptance or uncertainty prevents dispatch.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Attempt belongs to a different recipient.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("Recipient cannot transfer to another patient.");
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("ON occasion_campaign_attempts(sender_phone_number_id, provider_message_id)");
  });
  it("does not contain financial-table changes, data deletion, a migration number or schema registration", () => {
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).not.toMatch(/ALTER TABLE (?:invoices|payments|journal|expenses)\b/i);
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).not.toMatch(/DELETE FROM|TRUNCATE TABLE|INSERT INTO schema_migrations|004[1-9]_/i);
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).not.toContain("ensureSchema");
  });
  it("guards statement-level truncation of all campaign evidence tables", () => {
    for (const table of ["occasion_campaigns", "occasion_campaign_send_requests", "occasion_campaign_batches",
      "occasion_campaign_recipients", "occasion_campaign_attempts"]) {
      expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain(`BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT`);
    }
    expect(OCCASION_CAMPAIGN_SCHEMA_SQL).toContain("database owners can bypass triggers");
  });
});
