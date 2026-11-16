# Tooth-group presentation in invoice entry

## Scope

The prospective manual invoice editor presents one intentionally selected service/tooth batch as one line: selected tooth count × the common per-tooth price, with one provider selector. This changes entry presentation only. It does not change catalog pricing units, create a whole-bridge price, infer bridge abutments, or group existing saved invoices or printouts.

Canonical rows remain one per tooth. Preview, save, immutable command recovery, receipts, plan-item source identity, independent endodontic cases, prosthetic episode membership, invoice currency, discounts, and commission attribution continue to use those individual children.

Historical agreements are outside this projection. A historical prosthetic agreement retains its one original whole-episode amount.

## Display and editing contract

- `displayGroupId` is an editor-only selection-batch identifier, distinct from the existing clinical editor `groupId` and `episodeTeeth`. It is never sent to an API.
- Equal names, prices, or doctors alone do not establish a batch. Independent explicit groups remain separate.
- A batch is partitioned for presentation when service, provider, price/reason, prosthetic episode, or source context differs. Per-tooth case and plan-item identities remain independent children, not a shared identity. For filling/sealant services, surfaces belong to each tooth and may differ within the visible batch; other modes retain the surface compatibility check.
- The selected tooth count is not independently editable. Change it with the tooth selector. Generated children each have quantity one.
- Common price/provider changes apply to the compatible visible children. The tooth details control can explicitly separate a child for a different price or provider without changing its clinical membership.
- Reselecting a visible subgroup retains existing tooth keys and case choices, removes deselected children, and adds new children with the subgroup's price/provider but without copied case/plan-item identity. A subgroup cannot claim a tooth already owned by another same-service row.
- Filling selection carries an explicit surface map keyed by tooth. The dialog presents one labelled surface selector for every selected tooth. Removing/re-adding a tooth clears its surfaces; cancelling does not change invoice rows. Surface changes invalidate that child's linkage, and the existing form selection owner invalidates plan-selection evidence when clinical input changes. Filling children never gain `groupId` or `episodeTeeth`, and do not require a specialist case.
- Changing the service collapses the selected display group to one reset entry. Removing a display group removes its own children and preserves other episode members through the existing clinical removal helper.
- Invalid mid-typing prices remain in their explicit batch when the raw draft text matches. They do not acquire a fabricated total or bypass existing validation.
- Pending/uncertain money commands disable editing. Captured entry handlers cannot modify a retained command; retry submits its original canonical body.

## Saved/printed grouping boundary

Current invoice storage does not persist the editor batch ID. A saved line exposes its canonical tooth and case, but endodontic children intentionally have independent cases. Identical service/price/provider values cannot prove that historic lines were chosen together. No old record should be backfilled or coalesced on that inference.

Printed rows remain separate and show the saved tooth and surfaces in the description cell. This uses the existing invoice reader and does not infer or persist grouping.

A future saved/printed presentation change therefore needs a separately reviewed additive persistence contract for new invoice batches, not a schema change hidden inside this editor fix. A possible design is a nullable presentation-only batch token on each new canonical invoice line, scoped to its invoice and bound to the exact submitted command. Financial/clinical source identities would remain unchanged. Display readers would still partition incompatible children rather than trusting a token to override provenance.

That future design must cover parsing, command fingerprints, transaction validation, canonical acknowledgements, correction/reissue receipts and copying rules, current and archived reads, print rendering, and absent/invalid metadata behavior. Historical rows remain ungrouped without explicit trustworthy evidence. No migration number or schema implementation is allocated here.
