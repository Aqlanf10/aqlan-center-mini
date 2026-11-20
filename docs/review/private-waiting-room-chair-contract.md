# Waiting-room chair range safety (private candidate)

Baseline 0dfd80a accepts and stores a staff-authorized call to a globally
invalid chair 21. The public JSON repeats the number and the display parser
throws, causing the page to clear every element of its feed. An old room
can also remain structurally legal but no longer have a configured chair.

The existing physical range is 1–20, with default 2, and operational choices
already use the configured count. The settings writer already rejected a
count over 20; its visible metadata now agrees. No default, mode, data
migration, or live clinic setting is changed. Visit writers use the bound
before persisting a new call/seat or re-issuing a historical call. They take
the shared form of the central settings writer's transaction-advisory key,
which serializes even the first setting insertion while unrelated valid
chairs still run independently. The bounded check runs in the existing
transaction after canonical resource admission; invalid destinations make no
visit/audit change. An actual config reduction can make historical rows
inadmissible, but staff can still return and reassign them. This lock covers
participating central settings and queue writers, not direct SQL or historical
sources; the public projection handles those defensively.

Only the newest call is eligible. If it carries a malformed/out-of-config
numeric destination, suppress that call without resurfacing another and keep
editorial announcements and the other allowed public content. An explicit
null destination still means reception. Bad numbers never turn into
reception audio. No public schema/key, masking mode, staff access, voice
fallback, production or staging state is changed.
