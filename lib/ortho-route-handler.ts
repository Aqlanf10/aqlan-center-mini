import { BodyTooLargeError, MalformedBodyError } from "./http-body";
import { journeyResponse, journeyRouteError } from "./ortho-journey-route";
/** Every outcome, including refusal and uncertainty, is private. */
export function orthoRouteFailure(error: unknown, write: boolean) {
  if (error instanceof BodyTooLargeError) return journeyRouteError(413, "body_too_large", error.message);
  if (error instanceof MalformedBodyError) return journeyRouteError(400, "invalid_body", error.message);
  return journeyRouteError(500, write ? "write_unconfirmed" : "read_failed",
    write ? "تعذّر تأكيد الحفظ؛ احتفظ بمعرّف الطلب ومحتواه للتحقق." : "تعذّر قراءة السجل؛ لم يُعتبر فارغًا.");
}
export function orthoResult(result: { ok: true; replayed?: boolean } | { ok: false; status?: number }, write = false) {
  return journeyResponse(result, result.ok ? write && !result.replayed ? 201 : 200 : result.status ?? 400);
}
export function orthoQuery(request: Request, allowed: readonly string[]): URLSearchParams | null {
  const params = new URL(request.url).searchParams;
  return [...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1) ? null : params;
}
