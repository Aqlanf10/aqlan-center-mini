# WhatsApp occasion campaign foundation

Tracking: [MSG-OCCASION-CAMPAIGNS, issue #303](https://github.com/Aqlanf10/aqlan-center-mini/issues/303).

This is a foundation for the requested clinic occasion campaigns. The feature is
not enabled or available in the application. There are no campaign routes, UI,
runtime database/provider adapters, registered migrations or production settings.
The SQL exports are unregistered text contracts and never execute on import.

The modules provide strict endpoint/occasion consent and recipient states,
immutable provider-approved template bindings, bounded admin-session batch
orchestration, injected persistence/lease contracts and shared endpoint STOP
guards. Explicit international numbers retain their country code. Local numbers
need an explicit country context. Provider acceptance is distinct from delivery;
uncertain outcomes never authorize automatic retries.

Seven unit-test files use synthetic contacts, injected query fakes and fake
transports. They enter the existing unit/typecheck/lint CI paths without changing
CI configuration. Source review is complete; CI results must be checked for the
published commit. Fake-query tests do not establish PostgreSQL locking, constraint
or migration correctness, and no live provider readiness is implied.

Before enabling this feature:

1. Coordinate and verify additive schema registration and disposable PostgreSQL
   concurrency tests, including leases, STOP, cancellation and uncertain outcomes.
2. Implement the complete contact projection and atomic lifecycle/consent hooks
   across patient edits, import, booking, visit resolution, merge and deletion.
3. Compose current server-side provider/readiness and exact sender/account
   verification, durable callback reconciliation and every legacy outbound STOP
   boundary. Preserve ordinary consent defaults; historical grants are not
   occasion opt-in and ordinary grants cannot clear STOP.
4. Add admin-only draft, preview, explicit send, bounded batch, status, cancel and
   retry flows with permission/audit/CSRF controls. Page/session closure pauses
   future batches. Cancellation covers unclaimed work; in-flight work cannot be
   recalled. No unattended scheduler is included.
5. Verify the integrated HTTP/UI/database flow and actual configured provider
   readiness before any separate production enablement or real message send.

Do not wire a provider transport directly to the internal dispatch bridge or
resume a previously claimed attempt. Durable acquire/claim flow owns deduplication;
private claims, leases and credential-bearing gates must stay server-side.
