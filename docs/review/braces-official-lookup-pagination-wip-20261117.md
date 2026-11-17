# Official lookup Link handling — WIP

The official audit verifier requires live, complete evidence and fails closed.
This checkpoint rejects every nonempty `Link` response header rather than trying
to recognize only one spelling of a pagination relation. The notice is fixed
and does not contain the header or response body. No token, retry, cached
evidence, or fallback has been added.

This is deliberately conservative: a valid non-pagination `Link` also blocks
verification until reviewed. Empty or absent `Link` remains acceptable, subject
to all the existing HTTP, identity, JSON, size and evidence checks. This change
does not establish that any previous audit accepted an incomplete result.

Synthetic mock tests exercise Link variations and fail-closed behavior; they do
not prove current official-service behavior or the cause of a hosted CI failure.
