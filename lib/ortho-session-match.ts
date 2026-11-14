/**
 * Provenance check shared by the server replay path and the screen's cached-receipt recovery (reviews on
 * #483 6872647524 and 6873798343): do a recorded session's clinical values equal what this request would
 * have written? Same normalization as the session writer: trimmed text, empty -> null. A blank wire
 * without "remove" kept the case's wire at that time and is not compared. The visit date is compared only
 * when both sides carry it (the server's fingerprint already binds it).
 *
 * Equal values are not proof that the request created the session, or that photos belong to it: a
 * historical binding with identical values cannot be told apart. Callers therefore never upload photos on
 * recovery; a match only allows the recorded session to be shown as the saved result.
 */
export interface RecordedSessionValues {
  doneOn?: string | null; phase: string | null; upperWire: string | null; lowerWire: string | null; elastics: string;
  elasticNote: string | null; done: string | null; nextWeeks: number; note: string | null;
  auxiliaries: readonly string[] | null; auxiliaryOther: string | null;
}
export interface SessionRequestValues {
  doneOn?: string | null; phase?: string | null; upperWire: string | null; lowerWire: string | null;
  upperWireAction?: string; lowerWireAction?: string; elastics: string; elasticNote: string | null;
  done: string | null; nextWeeks: number; note?: string | null;
  auxiliaries?: readonly string[] | null; auxiliaryOther?: string | null;
}
export function recordedSessionMatchesRequest(recorded: RecordedSessionValues, request: SessionRequestValues): boolean {
  const text = (value: string | null | undefined) => value?.trim() || null;
  const wire = (saved: string | null, sent: string | null, action?: string) =>
    action === "remove" ? saved === null : text(sent) === null || saved === text(sent);
  const sentAuxiliaries = request.auxiliaries == null ? null : [...request.auxiliaries];
  const savedAuxiliaries = recorded.auxiliaries == null ? null : [...recorded.auxiliaries];
  return (request.doneOn == null || recorded.doneOn == null || request.doneOn === recorded.doneOn)
    // phase and note are compared only when the caller knows them (the server passes its exact input; the
    // screen never sends them and leaves them undefined, so they are not judged there).
    && (request.phase === undefined || (request.phase ?? null) === recorded.phase)
    && request.elastics === recorded.elastics && request.nextWeeks === recorded.nextWeeks
    // Both sides are normalized: the writer stores trimmed text with empty as null, but a read projection
    // (or a synthetic one) may present an empty string for the same recorded value.
    && text(request.elasticNote) === text(recorded.elasticNote) && text(request.done) === text(recorded.done)
    && (request.note === undefined || text(request.note) === text(recorded.note))
    && wire(text(recorded.upperWire), request.upperWire, request.upperWireAction)
    && wire(text(recorded.lowerWire), request.lowerWire, request.lowerWireAction)
    && JSON.stringify(sentAuxiliaries) === JSON.stringify(savedAuxiliaries)
    && (sentAuxiliaries === null ? text(recorded.auxiliaryOther) === null : text(request.auxiliaryOther) === text(recorded.auxiliaryOther));
}
