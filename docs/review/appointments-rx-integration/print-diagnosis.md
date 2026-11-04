# Lab PDF failure diagnosis

The failure is in the lab dispatch PDF field oracle, before any Rx assertion.
Neither the approved Rx template nor the oracle is changed by this diagnosis.

On Chromium 151.0.7922.173 with Poppler 25.03.0, the service label occupies one
valid block but its RTL-ordered extracted words are `عون`, `لمعلا`,
`:ةبيكرتلاو`: three tokens, with the colon attached to the last Arabic word.
`labelEquals` in `__tests__/helpers/lab-dispatch-pdf-fields.ts` requires exactly
four tokens matching `نوع`, `العمل`, `والتركيبة`, `:`. It therefore returns false
for the actual label, and `only` reports zero matching service-label blocks.
The impression label likewise has two tokens instead of the expected three;
the lab label also carries its colon in the same extracted token. Merely
ignoring the first error would not establish the remaining field assertions.

The full synthetic service identifier is present, untruncated, in its own block
between the two labels. More decisively, the detached untouched Rx candidate
`b804d515` and composed source `70f5114e` produce byte-identical PNGs and complete
geometry JSON, not only the same error message:

- PNG SHA-256: `87d702ebe1379ec5e2d7546aaa9dd9a78765d85aefc6abb16f9c81ec565c28ee`.
- Geometry SHA-256: `a6a3e5dc341571f35687bfc969aa87989a2f9a5c72a4b6425a17cf0ec66480a8`.

`evidence/lab-pdf-diagnosis/comparison.json` retains the exact label/value blocks
and coordinates from both inputs; both original PDFs and their identical PNG
are retained alongside it. PDF file hashes need not match because PDF metadata
includes generation times.

This establishes the immediate cause as an extraction-token-boundary mismatch
with the calibrated oracle, and excludes an appointments-induced visual change
in this witness. It does **not** isolate Chromium versus Poppler versus font
version as the upstream cause. The unchanged test must still run on the supported
GitHub image/browser. No token concatenation, relaxed geometry, skipped case,
changed fixture, or altered approved design is used to obtain a green result.
