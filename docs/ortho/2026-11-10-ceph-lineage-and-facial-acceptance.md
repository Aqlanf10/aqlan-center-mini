# Cephalometric correction lineage and actual browser acceptance

Checkpoint: `223c864c2b1d50b9ef4e49382027af50d06882dd`, branch `feat/ortho-reconcile-20261109`. This checkpoint was confirmed on the remote branch. The additional facial browser test is committed as `0726381e` and ran against the same built application. No main merge or deployment occurred.

## What changed

Previously a correction could carry a human note without a structured, immutable parent relation. Migration0124 now records the original analysis, case/image identity and exact observed source proof. Existing originals, notes and hashes are not rewritten; older unversioned sources remain explicitly unversioned. Saved study capture4 preserves the earlier witness strength and correction ancestry. The migration checksum is `0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355`.

The correction action uses the source token displayed when the study was opened. The envelope hash and source-snapshot hash have different meanings and are not compared for equality. A stale source is refused. An uncertain response retires the mounted correction action until the doctor reopens and reviews the source, preventing an immediate blind repeat. This is not a claim of persistent command-key recovery for all correction requests.

Archive history now explicitly loads older pages without automatically running queued exports. Measurement-source previews show the before/after source fields and allow opting out while leaving numerical measurements unchanged. Opening the source editor moves focus below the fixed header; typing does not repeatedly move focus.

## Executed evidence

On Node22 and local PostgreSQL18.6:

- Production build including TypeScript passed on223c864c.
- Focused unit regression:189/189 across5files.
- Combined PostgreSQL regression:48/48 across4files (measurement correction acceptance, archive expiry, archive backup/restore, ceph authority).
- Actual built HTTP/browser regression:47/47 across8files, including patient cockpit and prescription truth, source previews, archive paging, export permission, basic workup, ceph authorization and four correction-lineage cases.
- Additional facial browser journey:2/2 at390px and1280px against the223c application. Pointer placement and exact manual correction, thirds/fifths checked using independent known pixel distances, draft/review/save/reopen, two image dimensions, cancelled/confirmed switching, immutable old revisions, foreign patient denial and current permission revocation. No automatic diagnosis or financial entry was created. The first run reached the final permission fixture and failed because that fixture treated a text permissions column as jsonb; the fixture cast was corrected without changing application permissions.

The local browser was Chromium151; hosted browser evidence must be reported separately. New hosted run: https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/42748478290 . At this checkpoint print passed, while quality and PostgreSQL were still in progress; this document does not assert final CI success.

## Acceptance-matrix delta, not blanket completion

- O11: structured correction ancestry, immutable original, saved-study ancestry and actual browser stale/uncertain response behavior are now tested. This supersedes the earlier source-only observation that ancestry existed only in notes. Full longitudinal clinical acceptance remains separate.
- O40: the actual PostgreSQL journey changes one tooth width from7 to8, recalculates upper-arch and Bolton drafts, preserves the lower-arch result and old source/review/study/artifact hashes, then creates a new source-bound study and real PPTX. Calculations remain unapproved; explicit doctor review is kept distinct. All possible approved-analysis workflows are not thereby proved.
- O03/O04 and facial measurement acceptance: the described browser paths passed; this does not cover every possible race in every module.
- O21/O23/O31: editable PPTX layouts and visual checks already exist, but PDF parity, a second Office viewer and complete reference-layout acceptance remain outstanding.

The52-scenario inventory is a dated source audit. Its historical findings should be read with this later evidence, not silently relabelled as a complete clinical acceptance result.

## Remaining work and limits

Full CI for the assembled final head, complete scenario acceptance, closure/reopening integration, remaining model-presentation improvements and operational staging checks are still required. A visual review found the archive download link could overlap its timestamp; its fix and browser geometry regression are a later change, not part of this passed checkpoint. No clinical or staging readiness is claimed.

The other-cloud patch `b2d1d771` remains unavailable and was not read or applied. Existing local work and backups remain preserved. Only synthetic fixtures were used.
