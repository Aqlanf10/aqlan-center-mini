import { describe, expect, it } from "vitest";
import { imageSize } from "../lib/imageSize";

/** أبسط PNG بأبعاد معلومة — تُبنى يدويًا من ٢٤ بايتًا. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** JPEG بأبعاد معلومة: مقطعٌ قصير ثمّ SOF0 في موضعه الذي يقف عنده السائر.
 * (السائر يقفز `موقع العلامة + ٢ + طول المقطع` — فالمقطع القصير يضع
 * SOF0 عند ٨ لا عند ٦.) */
function jpeg(width: number, height: number, marker = 0xffc0): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt16BE(0xffd8, 0);
  buffer.writeUInt16BE(0xffe0, 2);   // APP0
  buffer.writeUInt16BE(4, 4);        // طول APP0 (مع حقل الطول نفسه)
  buffer.writeUInt16BE(marker, 8);   // المقطع التالي — حيث يقف السائر
  buffer.writeUInt16BE(17, 10);      // طول SOF
  buffer.writeUInt8(8, 12);          // الدقة
  buffer.writeUInt16BE(height, 13);
  buffer.writeUInt16BE(width, 15);
  return buffer;
}

describe("أبعاد الصورة من الترويسة — بلا مكتبة", () => {
  it("PNG من كتلة IHDR", () => {
    expect(imageSize(png(800, 1000))).toEqual({ width: 800, height: 1000 });
  });

  it("JPEG من SOF0", () => {
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("ما ليس صورة يعيد null — PDF يُرفع سليمًا بلا أبعاد", () => {
    expect(imageSize(Buffer.from("%PDF-1.7 ..."))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(imageSize(Buffer.from("not an image at all"))).toBeNull();
  });

  it("أبعادٌ صفرية أو سالبة لا تُصدَّق", () => {
    expect(imageSize(png(0, 100))).toBeNull();
  });

  it("الجداول ليست إطارات: JPEG بأسماء شبيهة بـSOF لا يُقرأ منها رقم", () => {
    // 0xFFC4 = جدول هوفمان لا SOF — فلا تُقرأ منه أبعاد مهما بدت أرقامه معقولة.
    expect(imageSize(jpeg(640, 480, 0xffc4))).toBeNull();
    expect(imageSize(jpeg(640, 480, 0xffc8))).toBeNull();
    expect(imageSize(jpeg(640, 480, 0xffcc))).toBeNull();
  });
});
