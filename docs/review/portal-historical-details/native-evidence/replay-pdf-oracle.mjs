// Read-only replay of five exact raw PDF lines from the verified synthetic CI artifact.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const fixture = JSON.parse(readFileSync(new URL("./pdf-oracle-ci-lines.json", import.meta.url), "utf8"));
const raw = Object.values(fixture.rawLabelledLines).join("\n");
const expected = [
  ["الخصم المسجل", "0.00"], ["المبلغ المتفق عليه", "1,500.50"],
  ["المدفوع من قبل", "500.00"], ["المبلغ المتبقي", "1,000.50"], ["الرصيد الحالي", "1,000.50"],
];
function verify(text, removeDirectionalControls) {
  for (const [label, amount] of expected) {
    const lines = text.split("\n").filter((line) => line.includes(label));
    assert.equal(lines.length, 1, `one raw PDF line for ${label}`);
    assert.match(lines[0], new RegExp(`(^|[\\s\\u202a-\\u202e])${amount.replace(/[.,]/g, "\\$&")}([\\s\\u202a-\\u202e]|ر)`));
    const currencyText = removeDirectionalControls ? lines[0].replace(/[\u202a-\u202e\u2066-\u2069]/g, "") : lines[0];
    assert.ok(currencyText.includes("ر.س"), `exact SAR abbreviation for ${label}`);
  }
}
assert.throws(() => verify(raw, false), /exact SAR abbreviation/);
console.log("RED reproduced: original contiguous-currency assertion rejects actual CI text.");
verify(raw, true);
console.log("GREEN: all five literal raw numeric tokens, Arabic labels, and SAR abbreviations pass.");
for (const [name, changed] of [
  ["wrong YER currency", raw.replaceAll("ر\u202a.\u202cس", "ر\u202a.\u202cي")],
  ["wrong Arabic currency order", raw.replaceAll("ر\u202a.\u202cس", "س\u202a.\u202cر")],
  ["x100 wrong amount", raw.replaceAll("1,500.50", "150,050.00")],
  ["one-cent wrong prior payment", raw.replaceAll("500.00", "500.01")],
  ["wrong Arabic label", raw.replaceAll("المبلغ المتفق عليه", "المبلغ المتفق عله")],
]) {
  assert.notEqual(changed, raw, `counterexample actually changes source: ${name}`);
  assert.throws(() => verify(changed, true));
  console.log(`REJECTED: ${name}`);
}
