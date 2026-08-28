import { describe, expect, it } from "vitest";
import { safeEntryName, tarEnd, tarHeader, tarPadding } from "../lib/tar";

describe("أرشيف TAR", () => {
  it("الرأس ٥١٢ بايتًا ومجموعه صحيح", () => {
    const header = tarHeader("a.jpg", 3, new Date(0));
    expect(header.length).toBe(512);
    // يُعاد الحساب كما تفعل أدوات الفكّ: خانة المجموع تُعامل فراغات.
    let sum = 0;
    for (let i = 0; i < header.length; i += 1) {
      sum += i >= 148 && i < 156 ? 32 : header[i];
    }
    const stored = parseInt(new TextDecoder().decode(header.slice(148, 154)), 8);
    expect(stored).toBe(sum);
  });

  it("الحشو يُكمل إلى مضاعف ٥١٢", () => {
    expect(tarPadding(512).length).toBe(0);
    expect(tarPadding(3).length).toBe(509);
    expect(tarEnd().length).toBe(1024);
  });

  it("يمنع الخروج من المجلّد عند الفكّ", () => {
    expect(safeEntryName("../../etc/passwd", "x")).toBe(".-.-etc-passwd");
    expect(safeEntryName("أشعة/بانورامي", "x")).toBe("أشعة-بانورامي");
    expect(safeEntryName("   ", "احتياطي")).toBe("احتياطي");
  });
});
