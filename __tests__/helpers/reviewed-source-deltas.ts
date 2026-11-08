import { expect } from "vitest";

// Exact reviewed hunks, not regex normalization: every hunk must occur once.
// The caller hashes the recovered historical slice, so every other byte remains
// protected too. Never regenerate these fixtures merely to make a failure pass.
export function reverseReviewedDeltas(source: string, deltas: readonly { before: string; after: string }[]): string {
  let original = source;
  for (const { before, after } of deltas) {
    expect(after.length).toBeGreaterThan(0);
    expect(original.split(after)).toHaveLength(2);
    original = original.replace(after, before);
  }
  return original;
}
