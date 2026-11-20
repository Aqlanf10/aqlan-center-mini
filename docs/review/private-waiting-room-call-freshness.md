# Waiting-room playback freshness (private candidate)

Keeping only the last visible call key lets A speak twice after a newer B
becomes ineligible, for example after a chair count reduction, and then A
becomes the visible active call again. This also affects previously unseen
historical rows when configuration makes them eligible.

A TV tab now keeps one scalar: the greatest observed valid server feed
timestamp. Initial/reconnect/empty feeds are silent and advance that
watermark; an ordinary feed announces only if the selected call timestamp
falls strictly after the previous observed server watermark and no later
than the current server response time. The wall clock, patient or chart ID,
name, room, account and browser storage are not inputs to the watermark.
Visible latest-call behavior and public projection do not change. A changed
visible call cancels previously queued speech and clears stale emphasis;
reissuing a valid call with a provably newer timestamp works.

No client can distinguish two events in the same timestamp tick or infer
commit order from unavailable data. A delayed DB transaction stamped before
an already observed response, absent/tied time or a backwards server clock
can leave an otherwise visible new call silent. Staff can use a fresh
"إعادة النداء" where the destination is still configured. If a hidden and
restored call lies entirely between polls, the payload cannot distinguish
that from a genuinely new arrival; an explicit server-side event ordinal
would be required for proof against that case. Actual browser/TV acceptance
is still required. No product mode, cache, data shape or storage changes.
