# Fast VRSCTEST Daily Seed E2E

This procedure creates an isolated short-lived Daily Seed round. It exercises
the same commitment, gameplay, result, reveal, and verification path as a
calendar-day round without waiting until the next UTC day.

## Prepare an isolated round

Use a dedicated, gitignored SQLite database. Choose the open and close
timestamps once and keep the same values for all commitment lifecycle commands.
The close time must leave enough time for the commitment to confirm and for the
wallet login and game.

```powershell
$env:ARCADE_DATABASE_PATH = (Resolve-Path 'server/data').Path + '\vrsctest-e2e.sqlite'
$env:VERUS_ROUND_DATE = '2026-07-25'
$env:VERUS_ROUND_OPENS_AT = '2026-07-25T14:00:00.000Z'
$env:VERUS_ROUND_CLOSES_AT = '2026-07-25T14:20:00.000Z'

$env:VERUS_ROUND_LIFECYCLE_ACK = 'PREPARE_DURABLE_VRSCTEST_ROUND'
node scripts/integration/vrsctest-round-lifecycle.mjs prepare
```

Preparation signs but does not broadcast. Inspect the reported round,
commitment hash, journal state, and transaction ID.

## Broadcast and confirm the commitment

```powershell
$env:VERUS_ROUND_LIFECYCLE_ACK = 'SUBMIT_DURABLE_VRSCTEST_ROUND'
node scripts/integration/vrsctest-round-lifecycle.mjs submit

$env:VERUS_ROUND_LIFECYCLE_ACK = 'RECONCILE_DURABLE_VRSCTEST_ROUND'
node scripts/integration/vrsctest-round-lifecycle.mjs reconcile
```

Repeat only `reconcile` until `confirmed` is `true`. Never prepare a replacement
while the original submission is pending or uncertain.

## Play the round

Start the backend against the isolated database and start the web client:

```powershell
$env:ARCADE_DATABASE_PATH = (Resolve-Path 'server/data/vrsctest-e2e.sqlite').Path
node server/auth.mjs
```

In a second terminal:

```powershell
npm run dev
```

Complete the following checks with Verus Mobile on VRSCTEST:

1. Practice works without authentication.
2. VerusID login completes and restores a chain-bound session.
3. Daily displays the confirmed commitment.
4. Reserving Daily clearly consumes the single attempt.
5. A refresh resumes the same attempt and accepted actions.
6. A second reservation or second device cannot create another attempt.
7. Guesses are evaluated by the server and the client cannot submit a score.
8. The leaderboard reflects the authoritative attempt.

## Close and publish

After the committed close timestamp, use the round record ID with the guarded
operator runbook:

```powershell
$env:VERUS_OPERATOR_ACK = 'FINALIZE_VRSCTEST_ROUND'
node scripts/operator/round-lifecycle.mjs finalize word-grid:1.0.0:2026-07-25
```

Continue with the result prepare, submit, and reconcile commands in
[`OPERATOR_RUNBOOK.md`](./OPERATOR_RUNBOOK.md). Only after result confirmation
continue with reveal prepare, submit, and reconcile.

Finally verify:

- the public result proof against the confirmed result root;
- the revealed definition against the original commitment;
- the leaderboard state is `chain-verified`;
- no hidden field appeared in a public response before reveal confirmation.

The unavoidable waits in this accelerated procedure are VRSCTEST block
confirmations and the deliberately short committed gameplay window. No
calendar-day wait is required.

## Observed run: 2026-07-25

The first complete accelerated run used:

- round: `word-grid:1.0.0:2026-07-25`;
- open: `2026-07-25T08:29:00.000Z`;
- close: `2026-07-25T09:00:00.000Z`;
- player: `mrrager.VRSCTEST@`;
- one completed attempt with six accepted, server-authoritative guesses;
- answer after confirmed reveal: `shame`.

Confirmed VRSCTEST evidence:

- commitment transaction:
  `3c679b27ef7c4a12c7ff075b512e854b0f87d86356635ac76931bb9284db195c`;
- hidden-definition SHA-256:
  `e2d212ce5073492ab742db41d72345b86281e2d73623563776fc956f49ac2605`;
- result transaction:
  `838d8b9dbc3f1493dc0a35240c1f1571af8e30495e62c543d8ffbde14b27e69c`;
- result root:
  `bbb995ef75ca53f1beeb553d17bc145ef138bb3050b1314970b8f3adedfc7533`;
- result bundle SHA-256:
  `a784603ebf0323321f59d333ffd480969c3922e44f23c51405a544191dcac2b8`;
- reveal transaction:
  `4c018403aec5184e833e2431a8ec5d55d4ad86306da3484774b2cfc270ed6f19`.

Independent local verification reproduced the commitment from the confirmed
reveal and validated the player's inclusion proof against the confirmed result
root. The public leaderboard transitioned from `live` to `chain-verified` with
one rank-1 entry.

The run exposed and fixed three integration defects:

1. The default loopback callback was unreachable from Verus Mobile. The test
   backend was restarted with its LAN origin.
2. The wallet's uppercase `VRSCTEST` label was stored instead of the canonical
   authorization ID `vrsctest`. Login principals now fail closed on a different
   chain and store the configured canonical ID.
3. Daily incorrectly treated the curated answer list as an exhaustive guess
   dictionary. Word Grid v1.0.0 now enforces its documented five-ASCII-letter
   guess policy while retaining the curated list for answer selection.

All failures occurred before an invalid state transition: the login mismatch
could not reserve another chain's round, and the rejected guess did not consume
an action sequence. The durable attempt resumed after re-authentication.
