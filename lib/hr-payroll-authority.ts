import type { SessionPayload } from "./auth";
import type { HrPayrollWriteAuthorizer } from "./hr-payroll";
import { requireSession } from "./session";

/** Route-owned authorization. Never accept an authorizer or identity from the request body. */
export function hrPayrollWriteAuthorizer(session: SessionPayload): HrPayrollWriteAuthorizer {
  return Object.assign(async (client: Parameters<HrPayrollWriteAuthorizer>[0]) => {
    const live = await requireSession(client);
    return live?.role === "admin" && live.userId === session.userId && live.username === session.username;
  }, { isCurrent: () => session.expiresAt >= Date.now() });
}
