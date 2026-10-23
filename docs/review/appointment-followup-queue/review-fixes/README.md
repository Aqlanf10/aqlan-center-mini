# Independent review follow-up

## Durable retry ownership

On 090dae60, two editors/tabs mounted at one revision could replace the durable slot after the first save committed but its response was lost. A second revision conflict and Refresh could then erase the first attempt. The server revision guard still prevented duplicate events; the durable client evidence was defective.

Red-before: both real-browser cases fail at the exact persisted-body assertion. Green-after: the same two cases pass, along with the existing follow-up HTTP/mobile cases (4/4). They delay advisory notifications deliberately, hold the first real POST response after commit, click the stale editor while it is in flight, then drop the reply, reload and replay. The two-tab case also replaces the session cookie before the stale UI refreshes: the other actor cannot replay or clear the original actor's slot; switching back recovers it. Only the creation and one update event exist.

The editor now takes an origin-wide exclusive Web Lock (actor/patient/appointment) across context revalidation, read/persist/send and acknowledgement. Busy locks do not queue stale clicks. No unlocked/localStorage-lock fallback exists. A stale editor adopts the existing intent and asks for explicit replay. New intents re-read server revision before persistence. Successful receipts permit only compare-before-delete of the exact bytes; 400/404/409 never delete evidence. Refresh preserves it. Same-document/custom and cross-tab/storage events improve UI only, not correctness. Malformed evidence remains untouched and blocks new intent.

Unknown/irrecoverably stale attempts deliberately remain blocked for review; there is no client-side cancellation/retirement proof in this slice. Unsupported Web Locks or failed durable storage blocks submission.

## Exact old-head verification

The clean tracked 090dae60 tree was rerun on Node 22 after the first review request: 667 files / 11,633 unit tests passed. Only an untracked HTTP test excluded from the unit config was added while the run completed; no tracked source/test changed until completion. This resolves the earlier timezone-edit timing caveat for **090dae60 only**, not the subsequent fixes.

Existing push CI: https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/39998883245 . Quality's typecheck, lint, money scan and full unit step passed; dependency audit failed and build/preflight/runtime/HTTP were skipped. Follow this existing run, never create an evasion trigger.

The exact local `npm run ci:audit` also fails: `BRACES_EXCEPTION_REJECTED: known advisory disappeared; remove/review the exception`, while npm audit reports zero vulnerabilities. Package/lock/audit script bytes are identical to base #434. The official GitHub advisory metadata records GHSA-vfj7-8cjw-p6xm / CVE-2026-93687 withdrawn at 2026-10-23T12:53:02Z. Official latest braces is still 3.0.3. No new package version is proposed. Independently reviewing retirement of the obsolete exception/clean-audit path, without weakening other findings or patched/runtime proof, is separate security-policy work; no gate or dependency changed here. No raw hosted logs/artifacts were downloaded.
