# M2 slice 75 — patient documents and X-rays on the canonical runtime (group 3, 2026-11-04)

Fourth contract of group 3. Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes (5 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `GET /api/patients/[id]/documents` | `read:documents.list` (`clinical.xrays.view`), patient scope; hidden ones with `patients.documents.delete` or the owner | xrays role access; hidden ones for the admin label |
| `GET /api/documents/[id]` | `read:documents.file`, the document's patient in scope; bytes read after admission | the same by role |
| `POST /api/patients/[id]/documents` | `clinical.xrays.upload`, scope, size limit, associations, then file, row and audit | xrays upload role access |
| `DELETE /api/documents/[id]` | `patients.documents.delete`, scope, a written reason | admin label |
| `PUT /api/patients/[id]/photo` | `patients.edit`, scope | non-restricted labels with edit access |

## Behaviour

- **No write before admission:**
  - grant, scope, the configured size limit and the association checks run before a byte reaches the disk;
  - a forged signature leaves only its audit row and no file.
- **Order and atomicity:**
  - the file is written before its row (the legacy order: an orphan file is silent garbage, a row without a file is worse);
  - the row and its audit commit together;
  - a hide clears the patient photo pointer in the same transaction.
- **Privacy:**
  - the storage key never leaves the server;
  - a document of a patient outside the scope reads as missing;
  - downloads are `no-store` and `nosniff`.
- **Duplicate prevention:** an optional `requestKey` (the documents screen sends one) gives a receipt, so a double press keeps one document.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `documents-canonical` (new, temporary storage) | 4/4 |
| Legacy document / photo / historical-document storage suites | 62/62 |
| Related unit tests | 112/112 |
| Journey `canonical-documents-journey` (portOffset 126) | with the batch gates |

## Limits

- The consent modal's upload sends no request key yet (the field is optional). Its structured note rules are unchanged and enforced on both paths.
- The historical documents (`/historical-documents`) are treatment agreements carrying money (totals, discounts, amounts paid and remaining, account due). They move with the financial group (4), behind the explicit finance grants (owner rule 6615124926), not as a clinical document.
