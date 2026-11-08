/** Directional tokens are presentation-only: retain every recorded character.
 * Match dates before FDI pairs and isolate a signed quantity with its unit. */
const studyTokenPattern = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?\b|(?<![\w.])[+−-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[ \t]+(?:mm|µm|μm|um)(?![A-Za-z])|\b[1-8][1-8]-[1-8][1-8]\b/gu;
export const isolateStudyDateTokens = (text: string): string => {
  // Existing directional spans are opaque, preventing nested/crossing controls.
  let depth = 0, plain = '', result = '';
  const flush = () => { result += plain.replace(studyTokenPattern, value => `\u2066${value}\u2069`); plain = ''; };
  for (const character of text) {
    if (/[\u2066-\u2068]/u.test(character)) { flush(); depth++; result += character; }
    else if (character === '\u2069') { flush(); depth = Math.max(0, depth - 1); result += character; }
    else if (depth) result += character;
    else plain += character;
  }
  flush(); return result;
};

/** Presentation-only wrapping. Prefer word boundaries so an FDI contact, date or
 * short identifier remains intact. Never normalize, trim or discard source text.
 * Long unbroken tokens may continue across lines, but never split a surrogate
 * pair or grapheme cluster. An over-limit cluster is refused, not truncated. */
export function wrapStudyTextLine(text: string, maximum = 100): string[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10000) throw Error('study_text_wrap_limit');
  const protectedOffsets = new Set<number>();
  for (const match of text.matchAll(studyTokenPattern)) {
    const start = match.index!;
    if (Array.from(match[0]).length <= maximum) for (let offset = start + 1; offset < start + match[0].length; offset++) protectedOffsets.add(offset);
  }
  const clusters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), value => value.segment);
  const offsets = [0];
  for (const cluster of clusters) offsets.push(offsets[offsets.length - 1] + cluster.length);
  const lengths = clusters.map(value => Array.from(value).length);
  if (lengths.some(length => length > maximum)) throw Error('study_text_grapheme_limit');
  const lines: string[] = [];
  for (let start = 0; start < clusters.length;) {
    let end = start, count = 0, whitespace = start;
    while (end < clusters.length && count + lengths[end] <= maximum) {
      count += lengths[end];
      if (/^\s+$/u.test(clusters[end]) && !protectedOffsets.has(offsets[end + 1])) whitespace = end + 1;
      end++;
    }
    while (end > start && protectedOffsets.has(offsets[end])) end--;
    const stop = end === clusters.length ? end : whitespace > start ? whitespace : end;
    if (stop <= start) throw Error('study_text_token_limit');
    lines.push(clusters.slice(start, stop).join(''));
    start = stop;
  }
  return lines.length ? lines : [''];
}
