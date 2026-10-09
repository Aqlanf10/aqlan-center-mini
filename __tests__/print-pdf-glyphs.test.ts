import { describe, expect, it } from "vitest";
import { assertPrintPdfHeader, assertPrintPdfSignature, assertPrintPdfWatermark, assertReceiptPrintPdfSignature, matchesPrintPdfWord, type PrintPdfPage } from "./helpers/print-pdf-glyphs";

// Actual synthetic failed PDF from CI37709082384, SHA-256
// d93af041b99a8b493f54df253efa0fd80b7c336cad3fde654de4480cace09756.
// Only its bounded header, signature labels and central watermark glyph boxes are retained.
const header = "مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان\nد. عقلان الكامل — أخصائي تقويم الأسنان\nجامعة مانيلا المركزية — الفلبين\nفاتورة";
const observed: PrintPdfPage = {
  "width": 595.91998,
  "height": 842.88,
  "words": [
    {
      "text": "نانسلأا",
      "xMin": 147.426,
      "yMin": 56.384,
      "xMax": 185.486,
      "yMax": 76.636
    },
    {
      "text": "ليمجتو",
      "xMin": 189.23,
      "yMin": 56.384,
      "xMax": 228.453,
      "yMax": 76.636
    },
    {
      "text": "ةعارزو",
      "xMin": 231.783,
      "yMin": 56.384,
      "xMax": 268.01,
      "yMax": 76.636
    },
    {
      "text": "ميوقتل",
      "xMin": 271.34,
      "yMin": 56.384,
      "xMax": 304.505,
      "yMax": 76.636
    },
    {
      "text": "لماكلا",
      "xMin": 307.901,
      "yMin": 56.384,
      "xMax": 342.215,
      "yMax": 76.636
    },
    {
      "text": "نلاقع",
      "xMin": 345.96,
      "yMin": 56.384,
      "xMax": 376.923,
      "yMax": 76.636
    },
    {
      "text": "روتكدلا",
      "xMin": 380.274,
      "yMin": 56.384,
      "xMax": 416.835,
      "yMax": 76.636
    },
    {
      "text": "زكرم",
      "xMin": 420.58,
      "yMin": 56.384,
      "xMax": 447.006,
      "yMax": 76.636
    },
    {
      "text": "نانسلأا",
      "xMin": 227.684,
      "yMin": 77.254,
      "xMax": 251.623,
      "yMax": 86.548
    },
    {
      "text": "ميوقت",
      "xMin": 253.869,
      "yMin": 77.254,
      "xMax": 272.569,
      "yMax": 86.548
    },
    {
      "text": "يئاصخأ",
      "xMin": 274.811,
      "yMin": 77.254,
      "xMax": 300.997,
      "yMax": 86.548
    },
    {
      "text": "—",
      "xMin": 303.243,
      "yMin": 77.438,
      "xMax": 311.228,
      "yMax": 86.357
    },
    {
      "text": "لماكلا",
      "xMin": 313.443,
      "yMin": 77.254,
      "xMax": 335.134,
      "yMax": 86.548
    },
    {
      "text": "نلاقع",
      "xMin": 337.381,
      "yMin": 77.254,
      "xMax": 357.873,
      "yMax": 86.548
    },
    {
      "text": ".د",
      "xMin": 360.569,
      "yMin": 77.438,
      "xMax": 366.342,
      "yMax": 86.357
    },
    {
      "text": "نيبلفلا",
      "xMin": 244.876,
      "yMin": 89.238,
      "xMax": 267.316,
      "yMax": 98.532
    },
    {
      "text": "—",
      "xMin": 269.563,
      "yMin": 89.421,
      "xMax": 277.547,
      "yMax": 98.341
    },
    {
      "text": "ةيزكرملا",
      "xMin": 279.761,
      "yMin": 89.238,
      "xMax": 308.194,
      "yMax": 98.532
    },
    {
      "text": "لاينام",
      "xMin": 310.44,
      "yMin": 89.238,
      "xMax": 326.701,
      "yMax": 98.532
    },
    {
      "text": "ةعماج",
      "xMin": 329.135,
      "yMin": 89.238,
      "xMax": 349.05,
      "yMax": 98.532
    },
    {
      "text": "ةروتاف",
      "xMin": 281.763,
      "yMin": 116.69,
      "xMax": 312.208,
      "yMax": 135.387
    },
    {
      "text": "ن",
      "xMin": 388.124,
      "yMin": 360.845,
      "xMax": 394.725,
      "yMax": 401.349
    },
    {
      "text": "س",
      "xMin": 366.913,
      "yMin": 370.289,
      "xMax": 388.069,
      "yMax": 410.793
    },
    {
      "text": "ةخ",
      "xMin": 338.175,
      "yMin": 377.296,
      "xMax": 366.484,
      "yMax": 423.587
    },
    {
      "text": "ا",
      "xMin": 299.429,
      "yMin": 400.335,
      "xMax": 306.654,
      "yMax": 440.839
    },
    {
      "text": "عم",
      "xMin": 306.955,
      "yMin": 391.805,
      "xMax": 331.29,
      "yMax": 437.488
    },
    {
      "text": "د",
      "xMin": 288.481,
      "yMin": 405.209,
      "xMax": 299.042,
      "yMax": 445.713
    },
    {
      "text": "بط",
      "xMin": 255.208,
      "yMin": 416.672,
      "xMax": 281.609,
      "yMax": 460.527
    },
    {
      "text": "ا",
      "xMin": 247.681,
      "yMin": 423.374,
      "xMax": 254.907,
      "yMax": 463.878
    },
    {
      "text": "ع",
      "xMin": 233.313,
      "yMin": 429.772,
      "xMax": 247.463,
      "yMax": 470.275
    },
    {
      "text": "ت",
      "xMin": 225.786,
      "yMin": 433.123,
      "xMax": 232.942,
      "yMax": 473.626
    },
    {
      "text": "ه",
      "xMin": 214.838,
      "yMin": 437.997,
      "xMax": 225.77,
      "yMax": 478.501
    },
    {
      "text": "ا",
      "xMin": 207.312,
      "yMin": 441.348,
      "xMax": 214.538,
      "yMax": 481.852
    },
    {
      "text": ":بساحملا",
      "xMin": 539.064,
      "yMin": 359.054,
      "xMax": 572.71,
      "yMax": 367.974
    },
    {
      "text": ":ضيرملا",
      "xMin": 59.189,
      "yMin": 359.054,
      "xMax": 86.843,
      "yMax": 367.974
    }
  ]
};
const fresh = (): PrintPdfPage => structuredClone(observed);

describe("region-bound print PDF glyph calibration", () => {
  it("preserves the complete colon-bearing labels on the observed signature row", () => {
    expect(() => assertPrintPdfSignature(observed, "المحاسب: ................\nالمريض: ................")).not.toThrow();
  });
  it("rejects missing, reversed-position, out-of-region or punctuation-lost signature labels", () => {
    const expected = "المحاسب: ................\nالمريض: ................";
    const missing = fresh();
    missing.words = missing.words.filter(word => word.text !== ":بساحملا");
    expect(() => assertPrintPdfSignature(missing, expected)).toThrow(/PDF signature/);
    const reordered = fresh();
    const accountant = reordered.words.find(word => word.text === ":بساحملا")!;
    const patient = reordered.words.find(word => word.text === ":ضيرملا")!;
    [accountant.xMin, patient.xMin] = [patient.xMin, accountant.xMin];
    [accountant.xMax, patient.xMax] = [patient.xMax, accountant.xMax];
    expect(() => assertPrintPdfSignature(reordered, expected)).toThrow(/PDF signature/);
    const outside = fresh();
    for (const word of outside.words) if ([":بساحملا", ":ضيرملا"].includes(word.text)) { word.yMin = 30; word.yMax = 39; }
    expect(() => assertPrintPdfSignature(outside, expected)).toThrow(/PDF signature/);
    const punctuation = fresh();
    punctuation.words.find(word => word.text === ":بساحملا")!.text = "بساحملا";
    expect(() => assertPrintPdfSignature(punctuation, expected)).toThrow(/PDF signature/);
  });
  it("recognizes the observed lam-alef glyph order without accepting scrambled words", () => {
    expect(matchesPrintPdfWord("نلاقع", "عقلان")).toBe(true);
    expect(matchesPrintPdfWord("نالقع", "عقلان")).toBe(true);
    expect(matchesPrintPdfWord("نانسلأا", "الأسنان")).toBe(true);
    expect(matchesPrintPdfWord("لاينام", "مانيلا")).toBe(true);
    expect(matchesPrintPdfWord("نقلعا", "عقلان")).toBe(false);
    expect(matchesPrintPdfWord("نلاقع", "عقلين")).toBe(false);
    expect(matchesPrintPdfWord("321-CNI", "INC-123")).toBe(false);
  });
  it("accepts the exact observed header words and spatial watermark run", () => {
    expect(() => assertPrintPdfHeader(observed, header)).not.toThrow();
    expect(() => assertPrintPdfWatermark(observed, true)).not.toThrow();
  });
  it("rejects missing, reordered or out-of-region header words even if letters exist elsewhere", () => {
    const missing = fresh();
    missing.words = missing.words.filter(word => !(word.text === "نلاقع" && word.yMin < 70));
    expect(() => assertPrintPdfHeader(missing, header)).toThrow(/PDF header/);
    const reordered = fresh();
    const name = reordered.words.find(word => word.text === "نلاقع" && word.yMin < 70)!;
    name.xMin = 100; name.xMax = 130;
    expect(() => assertPrintPdfHeader(reordered, header)).toThrow(/PDF header/);
    const outside = fresh();
    for (const word of outside.words) if (word.yMax < 140) { word.yMin += 220; word.yMax += 220; }
    expect(() => assertPrintPdfHeader(outside, header)).toThrow(/PDF header/);
  });
  it("rejects missing or scrambled watermark glyphs and requires absence for first prints", () => {
    const missing = fresh();
    missing.words = missing.words.filter(word => word.yMax - word.yMin < 28);
    expect(() => assertPrintPdfWatermark(missing, true)).toThrow(/PDF watermark/);
    expect(() => assertPrintPdfWatermark(missing, false)).not.toThrow();
    expect(() => assertPrintPdfWatermark(observed, false)).toThrow(/PDF watermark/);
    const scrambled = fresh();
    const parts = scrambled.words.filter(word => word.yMax - word.yMin >= 28).sort((a, b) => b.xMin - a.xMin);
    [parts[0].text, parts[1].text] = [parts[1].text, parts[0].text];
    expect(() => assertPrintPdfWatermark(scrambled, true)).toThrow(/PDF watermark/);
  });
});

// Exact native A6 signature boxes from CI37834754641, reversal diagnostic PDF,
// 267180 bytes, SHA-256 8acbb0ad010ea856084d66d69755f95947b4e9acd96d44b59f4610e031df7446.
// The source document and all other native-PDF oracles remain unchanged.
const receiptSignature = "سجّله: secadmin\nالتوقيع: ................";
const observedReceipt: PrintPdfPage = {
  width: 298.079990, height: 420.000000,
  words: [
    { text: "جّس", xMin: 262.769864, xMax: 274.683447, yMin: 359.080087, yMax: 369.107012 },
    { text: ":هل", xMin: 253.077708, xMax: 262.417691, yMin: 359.263023, yMax: 368.168511 },
    { text: "secadmin", xMin: 216.757963, xMax: 250.863168, yMin: 359.263023, yMax: 368.168511 },
    { text: ":عيقوتلا", xMin: 59.620948, xMax: 83.491865, yMin: 359.263023, yMax: 368.168511 },
    { text: "................", xMin: 21.984374, xMax: 57.407811, yMin: 359.263023, yMax: 368.168511 },
  ],
};
const freshReceipt = (): PrintPdfPage => structuredClone(observedReceipt);
const receiptCorruptions: [string, (page: PrintPdfPage) => void][] = [
  ["missing right fragment", page => { page.words.splice(0, 1); }],
  ["missing left fragment", page => { page.words.splice(1, 1); }],
  ["separated fragments", page => { page.words[1].xMin -= 1; page.words[1].xMax -= 1; }],
  ["different-line fragments", page => { page.words[1].yMin -= 3; page.words[1].yMax -= 3; }],
  ["overlapping fragments", page => { page.words[1].xMax = page.words[0].xMin + 0.1; }],
  ["swapped fragment positions", page => {
    const right = page.words[0], left = page.words[1];
    [right.xMin, left.xMin] = [left.xMin, right.xMin];
    [right.xMax, left.xMax] = [left.xMax, right.xMax];
  }],
  ["out-of-region fragment", page => { page.words[1].yMin = 20; page.words[1].yMax = 29; }],
  ["out-of-page fragment", page => { page.words[1].xMin = -1; }],
  ["non-finite fragment", page => { page.words[1].xMin = Number.NaN; }],
  ["oversized merged box", page => { page.words[1].yMax = page.words[0].yMin + 16.1; }],
  ["duplicate fragment", page => { page.words.push({ ...page.words[0] }); }],
  ["duplicate out-of-region fragment", page => {
    page.words.push({ ...page.words[0], yMin: 20, yMax: 30 });
  }],
  ["duplicate fragmented anchor", page => {
    page.words.push(...page.words.slice(0, 2).map(word => ({ ...word, yMin: word.yMin - 20, yMax: word.yMax - 20 })));
  }],
  ["duplicate logical anchor", page => { page.words.push({ ...page.words[0], text: "سجّله:" }); }],
  ["duplicate visual anchor", page => { page.words.push({ ...page.words[0], text: ":هلجّس" }); }],
  ["missing shadda", page => { page.words[0].text = "جس"; }],
  ["lost colon", page => { page.words[1].text = "هل"; }],
  ["changed glyph", page => { page.words[0].text = "جّش"; }],
  ["scrambled glyphs", page => { page.words[0].text = "سجّ"; }],
  ["changed signer", page => { page.words[2].text = "otheradmin"; }],
  ["missing signer", page => { page.words.splice(2, 1); }],
  ["missing signature label", page => { page.words.splice(3, 1); }],
  ["missing entire signature", page => { page.words = []; }],
  ["extra word on signature row", page => {
    page.words.push({ text: "extra", xMin: 150, xMax: 170, yMin: 359.263023, yMax: 368.168511 });
  }],
];

describe("receipt-only marked signature fragment calibration", () => {
  it("accepts the observed adjacent fragments without changing the shared oracle or input", () => {
    const paper = freshReceipt(), before = structuredClone(paper);
    for (const word of paper.words) Object.freeze(word);
    Object.freeze(paper.words); Object.freeze(paper);
    expect(() => assertPrintPdfSignature(paper, receiptSignature)).toThrow(/PDF signature/);
    expect(() => assertReceiptPrintPdfSignature(paper, receiptSignature)).not.toThrow();
    expect(paper).toEqual(before);
  });
  it.each(receiptCorruptions)("rejects %s without changing its input", (_name, corrupt) => {
    const paper = freshReceipt();
    corrupt(paper);
    const before = structuredClone(paper);
    expect(() => assertReceiptPrintPdfSignature(paper, receiptSignature)).toThrow(/PDF signature/);
    expect(paper).toEqual(before);
  });
  it("never combines fragments across native PDF pages", () => {
    const firstPage = freshReceipt(), secondPage = freshReceipt();
    firstPage.words.splice(1, 1);
    secondPage.words = [secondPage.words[1]];
    for (const paper of [firstPage, secondPage]) {
      const before = structuredClone(paper);
      expect(() => assertReceiptPrintPdfSignature(paper, receiptSignature)).toThrow(/PDF signature/);
      expect(paper).toEqual(before);
    }
  });
  it("does not reconstruct the pair for any other expected label", () => {
    const paper = freshReceipt(), before = structuredClone(paper);
    for (const label of ["المستلم:", "المحاسب:", "سجله:"]) {
      expect(() => assertReceiptPrintPdfSignature(paper, `${label} secadmin\nالتوقيع: ................`)).toThrow(/PDF signature/);
    }
    expect(paper).toEqual(before);
  });
  it("delegates unfragmented signatures to the unchanged shared oracle", () => {
    const expected = "المحاسب: ................\nالمريض: ................";
    expect(() => assertReceiptPrintPdfSignature(observed, expected)).not.toThrow();
    const missing = fresh();
    missing.words = missing.words.filter(word => word.text !== ":بساحملا");
    expect(() => assertReceiptPrintPdfSignature(missing, expected)).toThrow(/PDF signature/);
  });
});
