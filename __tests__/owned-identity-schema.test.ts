import { expect, it, vi } from "vitest";
import type { Client } from "pg";
import { withOwnedIdentitySchema } from "./helpers/owned-identity-schema";

function fixture() {
  const query = vi.fn().mockResolvedValue({ rows: [{ oid: "42", owner: "7" }] });
  return { query, db: { query } as unknown as Pick<Client, "query"> };
}
it("uses a fresh validator-compatible name and removes only its matching owned schema", async () => {
  const { query, db } = fixture();
  const names: string[] = [];
  for (let i = 0; i < 2; i++) await withOwnedIdentitySchema(db, async name => { names.push(name); });
  expect(names[0]).toMatch(/^aqlan_identity_[a-f0-9]{16}$/);
  expect(names[1]).toMatch(/^aqlan_identity_[a-f0-9]{16}$/);
  expect(names[0]).not.toBe(names[1]);
  expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("DROP"))).toEqual(names.map(name => [`DROP SCHEMA ${name} CASCADE`]));
});
it("never cleans up after CREATE fails or has an uncertain outcome", async () => {
  const { query, db } = fixture(); query.mockRejectedValueOnce(new Error("CREATE failed"));
  const run = vi.fn();
  await expect(withOwnedIdentitySchema(db, run)).rejects.toThrow("CREATE failed");
  expect(run).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(1);
});
it.each([{ rows: [] }, { rows: [{ oid: "99", owner: "7" }] }, { rows: [{ oid: "42", owner: "9" }] }])("refuses cleanup after schema disappearance or identity change: %j", async ({ rows }) => {
  const { query, db } = fixture();
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ oid: "42", owner: "7" }] }).mockResolvedValueOnce({ rows });
  await expect(withOwnedIdentitySchema(db, async () => {})).rejects.toThrow("identity changed");
  expect(query.mock.calls.some(([sql]) => String(sql).startsWith("DROP"))).toBe(false);
});
it("refuses cleanup if creation identity cannot be established", async () => {
  const { query, db } = fixture(); query.mockResolvedValue({ rows: [] });
  await expect(withOwnedIdentitySchema(db, async () => {})).rejects.toThrow("ownership unavailable");
  expect(query).toHaveBeenCalledTimes(2);
});
it("cleans its owned schema on callback failure and preserves that failure", async () => {
  const { query, db } = fixture();
  await expect(withOwnedIdentitySchema(db, async () => { throw new Error("body failed"); })).rejects.toThrow("body failed");
  expect(String(query.mock.calls.at(-1)?.[0])).toMatch(/^DROP SCHEMA aqlan_identity_[a-f0-9]{16} CASCADE$/);
});
