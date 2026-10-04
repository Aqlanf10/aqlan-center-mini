# Raw service category display

Authorized service POST/PATCH accepts free category strings. Object prototype
names therefore are reachable stored categories. Previously ServiceSelect's
known-label lookup returned inherited functions or objects; normalization also
mistook `Constructor` for an owned known key. Selected service rendering could
lose the label or throw for `__proto__`. The commission detail DTO independently
returned inherited non-string labels, omitted by JSON or serialized as objects.

Two ServiceSelect guards and the categoryLabel expression in the existing
commissionDetailReport projection now look up only owned known labels. Unknown
keys retain their raw spelling; known Arabic labels and existing clinical
presentation normalization remain. No catalogue rewrite, category alias for
financial rates, numeric policy/default, schema, financial writer or historical
row change is introduced. PR245 owns the separate numeric by-category repair.

Local actual-source controls produced ten semantic/render failures and four
passing known/legacy controls. The fixed selected-service SSR/label suite passed
all fourteen. A prior CLI invocation with an unsupported Vitest option was an
invocation failure, not defect evidence. Scoped lint and full exact CI are
recorded with the final candidate; local HTTP/PG/browser execution is not claimed.

Built-app acceptance creates only disposable synthetic catalogue, doctor policy,
patient and signed financial fixtures. Eight authorized service POST to actual
commission-detail GET cases check string/raw labels, known RCT Arabic labels,
finite exact percentages and amounts, and unchanged complete invoice/items,
signed visit/procedure, payment and stored policy/history facts. The existing
percentage policy isolates this display boundary from the separate numeric fix.

Two RTL browser cases select constructor, __proto__ and toString services in the
existing Account manual-invoice form without submitting it. Actual selected label,
viewport bounds, native hits, no page error and no browser write are required.
The exact workflow uploads only two synthetic screenshots for independent visual
review. Finally only explicitly created service IDs are deactivated; all synthetic
historical facts and raw keys remain. No Production record operations are performed.

Release requires exact current-main integration, independent source review, full
CI, inspection of both fresh saved images, and coordinated merge/deployment.
This is a bounded display correction and does not complete the clinic or every
custom-category consumer.
