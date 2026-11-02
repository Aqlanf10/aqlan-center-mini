# Prescription paper: quarter A4 (A6)

The prescription route uses a named `prescription-a6` page, 105 × 148 mm,
with 6 mm margins. Only this route selects that page. Invoice, statement,
referral and all other paper defaults are unchanged. The modal label says A6.

A long prescription continues onto additional A6 sheets; content is never
truncated or scaled down to force a single page. Patient name, file number,
prescribing doctor and saved Rx identifier repeat through a table header.
Medication headings wrap; actual stored amount, strength, frequency, duration,
instructions, notes and immutable prescribing identity remain unchanged.
Only empty rule/signature spacing is reduced, not font sizes. Existing draft,
void, fresh print authorization and immutable saved-record safeguards remain.

## Acceptance evidence and outstanding gate

Synthetic SSR/unit tests verify retained content and updated labels. The real
Chromium/PDF suite includes short saved, short draft and 20-item continuation
cases. It requires every page to be A6, every word inside paper bounds, every
medication's distinct fields preserved, and repeated patient/doctor/Rx identity.
The built HTTP print test also requires A6 from the real saved-record route.

Local Chromium could not start due to the execution sandbox's process-socket
restriction; the requested escalation failed environment setup. No local PDF
geometry or visual acceptance is claimed. Exact-head hosted print and full HTTP
CI must pass before integration; do not infer acceptance from source review.
