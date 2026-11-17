import { describe, expect, it, vi } from "vitest";
import { read0090ColumnErrorCode } from "./helpers/standalone-0090-column-probe";

describe("synthetic 0090 column probe", () => {
  it("issues only the bounded read and returns the SQLSTATE without error details", async () => {
    const query = vi.fn(async (_sql: string) => { throw { code:"42703", detail:"synthetic free text" }; });
    expect(await read0090ColumnErrorCode(query)).toBe("42703");
    expect(query.mock.calls.length).toBe(1);
    expect(query.mock.calls[0][0] === "SELECT request_key FROM public.booking_requests LIMIT 0").toBe(true);
  });
  it("distinguishes a present column and a missing table", async () => {
    expect(await read0090ColumnErrorCode(async () => undefined)).toBeNull();
    expect(await read0090ColumnErrorCode(async () => { throw {code:"42P01"}; })).toBe("42P01");
  });
  it("withholds messages and non-SQLSTATE codes", async () => {
    expect(await read0090ColumnErrorCode(async () => { throw new Error("synthetic free text"); })).toBe("OTHER");
    expect(await read0090ColumnErrorCode(async () => { throw {code:"synthetic free text"}; })).toBe("OTHER");
  });
});
