# Prospective category rates

The users settings category editor now shows the fifteen raw catalog keys from
`CATEGORY_LABEL`, plus additional raw keys present in the loaded catalog or saved
configuration. A missing category override displays the actual general percentage,
including zero. Rendering, expanding the legacy section, or saving an untouched
form does not create missing category overrides. Editing a category changes only
that exact key; existing `endo`, other legacy keys, custom keys, and special service
rules remain intact. Known legacy keys retain their Arabic labels alongside the
raw key. Special service rules continue to take precedence.

This changes display and explicit user editing only. Parser defaults, raw category
resolution, permissions, database writers, and commission history remain unchanged.
There is no `endo` to `rct` migration, alias, copied rate, or backdated configuration.
The existing writer captures a baseline, locks the doctor party, and records the
new configuration with server time. Collected-cash policy uses each payment event;
invoiced policy uses the invoice event. Later collections of an earlier invoice
therefore continue to follow the existing selected basis.

Verification includes actual component handlers and the existing resolver, two
PostgreSQL report cases using the actual configuration writer under both bases,
and actual built-app RTL browser journeys at 1280 and 390 pixels. The journeys
check untouched missing keys, explicit `rct` and `filling` edits, unchanged legacy
and special rates, persisted history and audit, reopening, focus, 44-pixel input
targets, and viewport containment. Screenshot uploads allow exactly two synthetic
PNG files. Full PostgreSQL/browser execution and visual acceptance require the
exact-commit CI run; focused local tests alone do not establish those gates.
