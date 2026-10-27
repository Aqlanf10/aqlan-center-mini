# Inventory requirements for canonical identity and recovery

This is the transport's required integration contract, not a new global authority
implementation or permission catalogue. Reserved 0076 remains the canonical
owner. Inventory's independent realm/subject proposal at checkpoint 45447909 is
unaccepted. 0087/0088 are unallocated and unaccepted. No automatic account mapping
or production activation is permitted.

## Account identity is separate from the compatibility key

The frozen `principalKey = SHA256(['staff-principal-v1', realmId, userId])` can
locate compatible records. It cannot prove account continuity: a restore can
retain the target realm while importing another user with the same numeric ID.
The transport therefore needs a centrally governed persistent account subject
UUID, or equally explicit approved incarnation evidence, from the canonical
opaque session. Inventory must not generate its own user subject or realm.

The central adapter must distinguish verified continuity from unverified or
foreign source identity. An imported subject UUID is historical evidence, not
automatic permission for the current target account. Missing legacy identity
cannot be filled using the current username, numeric ID, role or v1 key.

## Immutable command evidence

An admitted command preserves these original values through retries and restore:

| Field | Meaning |
|---|---|
| Source realm and central account subject | Original authority/account provenance |
| Actor numeric ID and username snapshot | Original ledger/audit identity; not independent proof of current ownership |
| Client intent nonce | Persisted before the first admission request |
| Operation scope and server operation key | Original exact execution/retirement lock and result identity |
| Protocol, business action and complete payload | Exact request, including source document IDs and expected versions/digests |
| Request and admitted-envelope digests | Detect replacement or mutation; never grant permission |
| Admission execution generation | The target runtime generation in which execution was admitted |
| Admission/result/rejection/retirement evidence | Append-only outcome, audit and source linkage |

None is rewritten to fit the target realm, a re-created account or a new
generation. Browser recovery retains the original body and key on 403/409,
timeout, permission changes and reload. A new login cannot silently re-key it.

## Required narrow canonical interfaces

The HTTP adapter must obtain an opaque `requireStaffSession` context and pass it
to `revalidateStaffSessionInTransaction` under the caller's transaction. It must
use the central inventory/finance capabilities for each existing business action;
inventory will not define a competing role catalogue. Owner/delegate support
comes from that contract. A legacy path is permitted only when canonical control
explicitly returns that permission, never from an `admin` string alone.

The reviewed central result must provide verified account provenance, current
capability decision and current authority/quarantine state while its locks remain
held until transaction completion. The inventory adapter separately verifies the
target execution generation and original operation lock. Client JSON, serialized
session-like objects and asserted capability flags cannot stand in for opaque
server context.

Historical outcome recovery requires a separate, centrally governed binding
that proves the current authorized account may inspect the original source
realm/subject/actor command. It must identify the restoration/import lineage and
persisted binding evidence, retain exact original identifiers, and be checked
under the transaction. Names and storage layout belong to the central contract;
this document does not create a binding table or grant.

## Pending execution and terminal lookup are different decisions

Pending work may execute only when the original account continuity is verified,
current authority permits the action, and its admitted execution generation is
the current target generation. A generation mismatch prevents both execution and
automatic retirement. Even a valid historical read binding cannot silently
authorize old pending work after rollback or restore.

An original committed, rejected or retired result may be returned only after
the central recovery binding and exact immutable command/digest/result provenance
are verified. The result carries the original acknowledgement, not a newly
generated command. Browser clearing is restricted to that exact proven outcome.

Within a live generation, absence is checked only after acquiring the original
operation lock; another request may still be running. After an older snapshot is
restored, even that lock cannot prove that an absent source result never committed
elsewhere. The command remains uncertain, visibly held and unavailable for
automatic re-admission. Same-document replacement commands cannot bypass the hold.
Independent documents may proceed if their own current authority is valid.

## Target-owned restore generation and quarantine

The execution generation is not an authorization epoch, realm or account UUID.
It is a target-owned inventory restore fence. Source generation records may be
retained as historical command evidence, but cannot become the active target
generation through ordinary data replay.

The v6 supplier intent and rejection schema currently has an
`execution_epoch_id` foreign key to `staff_execution_epochs`. Mechanically
retargeting that key to canonical target generation history is invalid: target
generation history is not imported, so restored source business rows would refer
to absent generations. This is an explicit remaining schema integration defect.
Immutable source command provenance needs a separately reviewed representation
(for example a historical provenance relation with no authority semantics).
Original generation IDs, realm/subject evidence and command payloads remain
unchanged. A source provenance row cannot grant admission, establish current
identity, satisfy an authorization epoch or select the target's active generation.
The current target admission/fence is evaluated independently. No provenance
table or migration number is approved by this requirement alone.

The required sequence must compose with the exact 0076 maintenance protocol:
preflight and migration fence; drain/exclude inventory writers in a reviewed lock
order; establish quarantine before replay; retain target realm/control and target
generation; import immutable source business/command evidence without adopting
it; verify quarantine and provenance; require explicit owner recovery before any
execution resumes. A failed import cannot reopen authority or make old pending
work executable. The global contract owns the exact transaction boundaries and
recovery decision; inventory must not approximate them independently.

## Composition cases required before acceptance

- Same numeric user ID and target realm, but a different imported account: old
  pending commands remain held and terminal reads require proven binding.
- Verified same central subject, fresh login and unchanged generation: exact
  replay returns one original outcome without another stock or financial write.
- Older snapshot with missing result or admission: no absence-as-failure inference
  and no new nonce/key that could repeat the original business action.
- Original committed/retired/rejected evidence survives restoration exactly;
  current subject access is checked independently from stored actor snapshots.
- Restore source intents and rejections admitted under source generation S into a
  quarantined target whose current generation is T and whose canonical generation
  history intentionally contains no S. Import must preserve every source command
  and rejection without a dangling foreign key, copying S into active target
  authority, or rewriting S to T. Pending S commands cannot execute or retire;
  terminal source outcomes need a separately verified historical read binding.
  This exact composed restore case is **pending**, not covered by the existing
  old-proposal same-realm restore pass. Transport tests must exercise it after the
  reviewed source-provenance and canonical target contracts are available.
- Role/capability/credential change and concurrent quarantine or restore exclude
  writes until the transaction resolves under canonical locks.
- Restore failure, audit failure and owner-recovery refusal preserve quarantine
  and immutable historical evidence.
- Legacy command without subject/incarnation evidence remains explicitly
  unverified; no synthetic subject is attached to make it executable.

Exact 0076 session/capability/restore source and local-only 0077 payable proposal
are still required to implement and test these bindings. The supplied private
archive failed two supported materialization attempts and has no readable native
text. Independent purchasing implementation continues; isolated old-proposal
tests do not constitute this composition's acceptance.
