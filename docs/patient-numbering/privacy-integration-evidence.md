# Separate local privacy integration

Applied the independently reviewed patch against the exact 97724c2 file baseline,
after the PostgreSQL fixture checkpoint, with git apply --check.
Input SHA256: e5d7849db0626e5ab0868f794d16370571d5ac95f2beb330cafe07e49a7f0794.

Combined run: 203 tests passed in patient-prefix-privacy, ai-privacy,
staff-account-control, staff-capabilities, patient-numbering-command,
patient-numbering-policy and document-numbers suites. Targeted ESLint produced
zero errors and two preexisting no-useless-escape warnings in the unrelated name
mask regex. This is scoped text-mask regression evidence, not a complete privacy
audit or evidence that the numbering feature is enabled. No provider calls or
patient data were used. The patch remains local and unpublished.
