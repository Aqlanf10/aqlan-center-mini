/** Test-only, bounded classification. Neither input nor exception text is emitted. */
const SCENES = new Set(['original', 'reversal', 'replacement', 'void']);
const LIMIT = 8;
let count = 0;

export function classifySyntheticPdfReference(text: unknown, reference: unknown): string {
  if (typeof text !== 'string' || typeof reference !== 'string' || !reference) return 'unavailable';
  if (text.includes(reference)) return 'exact';
  const compactReference = reference.replace(/\s/g, '');
  if (compactReference && text.replace(/\s/g, '').includes(compactReference)) return 'whitespace';
  if (text.toLowerCase().includes(reference.toLowerCase())) return 'case';
  if (text.includes([...reference].reverse().join(''))) return 'reversed';
  return 'unmatched';
}

export function observeSyntheticPdfReferenceFailure(
  scene: unknown, text: unknown, reference: unknown,
  write: (line: string) => unknown = line => process.stdout.write(line),
): void {
  try {
    if (count >= LIMIT) return;
    count++;
    const fixedScene = typeof scene === 'string' && SCENES.has(scene) ? scene : 'other';
    const form = classifySyntheticPdfReference(text, reference);
    write(`::notice title=Synthetic receipt PDF reference::scene=${fixedScene} form=${form}\n`);
  } catch { /* Reporting must not replace the test assertion or original failure. */ }
}
