/** PostgreSQL sequences here increment by one; return the next candidate. */
export function nextSequenceCandidate(lastValue: string, isCalled: boolean): bigint {
  return BigInt(lastValue) + (isCalled ? 1n : 0n);
}
