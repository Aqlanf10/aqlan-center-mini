# External lab dispatch contract

Status: source candidate; isolated CI, native artifact inspection and review pending.

Lab preview, dedicated print, copied prescription and lab-follow-up text use one explicit external projection. They include the existing RX order reference, lab/clinic business contacts and limited technical specifications. Patient identity, demographics, internal free text, events and financial data are excluded. QR contains only the order reference. The sequential reference is not an access token; no public endpoint, schema migration or permission expansion is introduced. Internal patient linkage and the print page's staff/patient-access checks remain intact.

Every outward document clearly requests technical review. Omitted internal instructions and missing or unrecognized work, teeth, roles, shades or impression details receive visible warnings. Catalogue changes do not silently relabel saved work. Missing clinical facts are not supplied as defaults. A separately reviewed external-instructions field is future work.

Printing uses the dedicated authorized page. Parent-screen printing is blank while the preview is open. A4/A5 controls size the preview; the dedicated print remains A4.

Prepared verification uses synthetic data only: unit/React render checks plus both built-browser entrypoints, real clipboard, unvisited follow-up URL, all-page PDF text/metadata, parent-print isolation, natural close/reopen and unchanged internal records. Actual QR pixels must match the independently specified reference-only payload; native pixel decoding is asserted when available and otherwise reported unavailable. Full CI and artifact review are required before acceptance. No user save-dialog filename or deliberately delayed QR-encoder coverage is claimed.
