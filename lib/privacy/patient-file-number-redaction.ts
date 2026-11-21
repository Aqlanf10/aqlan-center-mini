/**
 * Unmounted privacy boundary for a future configurable file number. A candidate
 * prefix cannot distinguish a receipt from a patient identifier: both can use
 * e.g. INV-01500. Resolve ambiguous candidates against authoritative clinic
 * data before permitting outbound text. Never send raw candidates to a provider.
 */
const MAX_TEXT = 4_000;
const MAX_DISTINCT_CANDIDATES = 64;
const MAX_HISTORICAL_NUMBERS = 64;
const MAX_NUMBER_LENGTH = 64;
const MARKER = "[ملف محمي]";

const customPart = /[\p{L}\p{N}_/-]/u;
// Global regexes below are consumed via String.matchAll, which copies state.
// A Latin identifier can be adjacent to an Arabic conjunction without a space.
const candidatePattern = /(?<![A-Z0-9_])[A-Z]{1,6}-[0-9]+(?![A-Z0-9_])/gu;
const legacyPattern = /(?:(?<![A-Z0-9_])P-?[0-9]+(?![A-Z0-9_])|(?<![\p{L}\p{N}_])م-[0-9]+(?![\p{L}\p{N}_]))/gu;
// Label plus a delimited, number-bearing value. Don't swallow nearby clinical
// terms or guess that a financial label establishes that a token is nonclinical.
const labeledPattern = /(?<![\p{L}\p{N}_])(?:رقم[\p{Zs}\t]*ملف(?:[\p{Zs}\t]*المريض(?:ة)?)?|رقم[\p{Zs}\t]*الملف|ملف[\p{Zs}\t]*المريض(?:ة)?|ملف|PATIENT[\p{Zs}\t]+FILE(?:[\p{Zs}\t]+(?:ID|NUMBER|NO\.?))?|PATIENT[\p{Zs}\t]+ID)(?=[\p{Zs}\t]|[:#=`'"])(?:[\p{Zs}\t]*(?:[:#=]|IS\b|هو(?=[\p{Zs}\t]))[\p{Zs}\t]*|[\p{Zs}\t]+)(?:[`'"]?)([\p{L}\p{N}](?:[\p{L}\p{N}./_-]*[\p{L}\p{N}])?)(?![\p{L}\p{N}_/-]|[.][\p{L}\p{N}])/gdu;

type Span = { start: number; end: number };
type Folded = Readonly<{ text: string; starts: readonly number[]; ends: readonly number[] }>;
const formatMark = /\p{Cf}/u;

function fold(source: string): Folded {
  let text = "";
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const c of source) {
    if (!formatMark.test(c)) {
      const normalized = c.normalize("NFKC")
        .replace(/[a-z]/g, (latin) => latin.toUpperCase())
        .replace(/[\u2010-\u2015\u2212]/g, "-")
        .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) & 0x0f));
      text += normalized;
      for (let index = 0; index < normalized.length; index++) {
        starts.push(offset);
        ends.push(offset + c.length);
      }
    }
    offset += c.length;
  }
  return { text, starts, ends };
}

function originalSpan(value: Folded, start: number, end: number): Span {
  return { start: value.starts[start], end: value.ends[end - 1] };
}

function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function covered(value: Span, by: readonly Span[]): boolean {
  return by.some((span) => span.start <= value.start && span.end >= value.end);
}

function render(text: string, spans: Span[]): string {
  let output = "", cursor = 0;
  for (const span of mergeSpans(spans)) {
    output += text.slice(cursor, span.start) + MARKER;
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

export type PatientFileFact = Readonly<{
  number: string;
  // If a token is both a patient number and a receipt, it MUST be "patient".
  kind: "patient" | "not-patient";
}>;
export type PatientFileBoundary = {
  /** Authenticated, server-derived custom/old IDs relevant to this text context. */
  readonly historicalNumbers: readonly string[];
  /** One complete answer per normalized number; not trusted from HTTP request parameters. */
  readonly classify: (candidates: readonly string[]) => Promise<readonly PatientFileFact[]>;
};
export type PatientFileRedaction =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "limit" | "unverified" };

/**
 * Return no text when classification is missing, stale/incomplete (as attested
 * by the caller), or over bounds. The caller must also apply existing phone,
 * name and other independent privacy checks. This module doesn't transmit text.
 */
export async function redactPatientFileNumbers(
  text: string,
  boundary: PatientFileBoundary,
): Promise<PatientFileRedaction> {
  if (!Array.isArray(boundary?.historicalNumbers) || typeof boundary.classify !== "function") {
    return { ok: false, reason: "unverified" };
  }
  if (text.length > MAX_TEXT || boundary.historicalNumbers.length > MAX_HISTORICAL_NUMBERS) {
    return { ok: false, reason: "limit" };
  }
  const folded = fold(text);
  const explicit: Span[] = [];
  for (const match of folded.text.matchAll(legacyPattern)) {
    explicit.push(originalSpan(folded, match.index, match.index + match[0].length));
  }
  for (const match of folded.text.matchAll(labeledPattern)) {
    const [start, end] = match.indices![1];
    if (!/\p{Nd}/u.test(match[1])) continue;
    if (end - start > MAX_NUMBER_LENGTH) return { ok: false, reason: "limit" };
    explicit.push(originalSpan(folded, start, end));
  }
  for (const raw of boundary.historicalNumbers) {
    if (typeof raw !== "string" || raw.length > MAX_NUMBER_LENGTH) return { ok: false, reason: "limit" };
    const exact = fold(raw).text.trim();
    if (exact.length < 2 || exact.length > MAX_NUMBER_LENGTH) return { ok: false, reason: "limit" };
    for (let from = 0;;) {
      const start = folded.text.indexOf(exact, from);
      if (start === -1) break;
      const end = start + exact.length;
      const before = Array.from(folded.text.slice(Math.max(0, start - 2), start)).at(-1) ?? "";
      const after = String.fromCodePoint(folded.text.codePointAt(end) ?? 0);
      if (!customPart.test(before) && !customPart.test(after)) {
        explicit.push(originalSpan(folded, start, end));
      }
      from = start + 1;
    }
  }
  const known = mergeSpans(explicit);
  const pending = new Map<string, Span[]>();
  for (const match of folded.text.matchAll(candidatePattern)) {
    const location = originalSpan(folded, match.index, match.index + match[0].length);
    if (covered(location, known)) continue;
    if (match[0].length > MAX_NUMBER_LENGTH) return { ok: false, reason: "limit" };
    const locations = pending.get(match[0]) ?? [];
    locations.push(location);
    pending.set(match[0], locations);
    if (pending.size > MAX_DISTINCT_CANDIDATES) return { ok: false, reason: "limit" };
  }
  if (pending.size > 0) {
    try {
      const facts = await boundary.classify(Object.freeze([...pending.keys()]));
      if (!Array.isArray(facts) || facts.length !== pending.size) return { ok: false, reason: "unverified" };
      const seen = new Set<string>();
      for (const fact of facts) {
        const positions = pending.get(fact?.number);
        if (!positions || seen.has(fact.number) || (fact.kind !== "patient" && fact.kind !== "not-patient")) {
          return { ok: false, reason: "unverified" };
        }
        seen.add(fact.number);
        if (fact.kind === "patient") known.push(...positions);
      }
    } catch { return { ok: false, reason: "unverified" }; }
  }
  return { ok: true, text: render(text, known) };
}
