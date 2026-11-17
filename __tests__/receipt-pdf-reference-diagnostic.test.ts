import { expect, it } from 'vitest';
import { classifySyntheticPdfReference, observeSyntheticPdfReferenceFailure } from './fixtures/receipt-pdf-reference-diagnostic';

it('classifies fixed synthetic reference layouts without returning source text', () => {
  expect(classifySyntheticPdfReference('prefix A-123 suffix', 'A-123')).toBe('exact');
  expect(classifySyntheticPdfReference('prefix A - 123 suffix', 'A-123')).toBe('whitespace');
  expect(classifySyntheticPdfReference('prefix a-123 suffix', 'A-123')).toBe('case');
  expect(classifySyntheticPdfReference('prefix 321-A suffix', 'A-123')).toBe('reversed');
  expect(classifySyntheticPdfReference('prefix other suffix', 'A-123')).toBe('unmatched');
  expect(classifySyntheticPdfReference(null, 'A-123')).toBe('unavailable');
});

it('emits only fixed categories, even for injected scene and content, and never masks failures', () => {
  const output: string[] = [];
  const secret = 'synthetic-private-marker';
  observeSyntheticPdfReferenceFailure(`::error::${secret}`, secret, 'A-123', line => output.push(line));
  expect(output).toEqual(['::notice title=Synthetic receipt PDF reference::scene=other form=unmatched\n']);
  expect(output.join('').includes(secret)).toBe(false);
  expect(() => observeSyntheticPdfReferenceFailure('original', secret, 'A-123', () => { throw new Error(secret); })).not.toThrow();
});
