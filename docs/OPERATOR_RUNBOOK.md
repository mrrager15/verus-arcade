# Verus Arcade Round Operator Runbook

This runbook describes the guarded operator workflow for publishing a completed
daily round on VRSCTEST. Transaction preparation, submission, and confirmation
are deliberately separate so every signed payload can be inspected before
broadcast.

For a short-lived round that can be exercised in one session, first follow
[`VRSCTEST_E2E.md`](./VRSCTEST_E2E.md).

## Safety rules

- Run this workflow on `VRSCTEST` only.
- Never expose a hidden round definition before its reveal is confirmed.
- Inspect the round before every state-changing command.
- Do not finalize a round before `closesAt`.
- Confirm the result transaction before preparing the reveal.
- Run one command at a time; do not automate consecutive submissions.
- Back up the SQLite database before operating on production-like test data.
- Keep databases, RPC credentials, and transaction journals out of Git.

## Configuration

The CLI uses the server environment:

```powershell
# Optional. Defaults to server/data/arcade.sqlite, the same database the game
# server uses, so a round created here is immediately visible to players.
$env:ARCADE_DATABASE_PATH = (Resolve-Path 'server/data/arcade.sqlite').Path
# Optional. Defaults to Arcade@ (i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp) on VRSCTEST.
$env:VERUS_OPERATOR_IDENTITY_NAME = 'Arcade@'
$env:VERUS_OPERATOR_IDENTITY_I_ADDRESS = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp'
```

RPC credentials must point to a synchronized VRSCTEST daemon that controls the
operator identity.

```text
node scripts/operator/round-lifecycle.mjs <action> <round-record-id>
```

Actions are `list`, `inspect`, `round-create`, `round-submit`, `round-open`,
`finalize`, `results-prepare`, `results-submit`, `results-reconcile`,
`reveal-prepare`, `reveal-submit`, and `reveal-reconcile`. `list` and
`round-create` take no round id.

## 0. Create a new round (rotation)

A Daily round is identified by its UTC date: `word-grid:1.0.0:YYYY-MM-DD`.
It opens at 00:00 UTC and closes at 00:00 UTC the next day unless you pass
`--opens-at` / `--closes-at` (ISO 8601). Creating a round is three guarded
steps, like every other identity update in this project.

List what exists (read-only):

```powershell
node scripts/operator/round-lifecycle.mjs list
```

Step 1 — create the round and sign the commitment. This picks a random answer,
stores the hidden definition locally, and journals a signed `updateidentity`
transaction for `Arcade@` that is **not** broadcast yet. The CLI prints the
commitment (metadata plus the sha256 of the hidden definition), never the
answer.

```powershell
$env:VERUS_OPERATOR_ACK = 'CREATE_VRSCTEST_ROUND'
node scripts/operator/round-lifecycle.mjs round-create            # today (UTC)
node scripts/operator/round-lifecycle.mjs round-create --date 2026-11-09
Remove-Item Env:VERUS_OPERATOR_ACK
```

Running `round-create` again for the same date changes nothing and tells you
which step comes next. A past date, or a `--closes-at` in the past, is refused.

Step 2 — broadcast the signed commitment:

```powershell
$env:VERUS_OPERATOR_ACK = 'SUBMIT_VRSCTEST_ROUND'
node scripts/operator/round-lifecycle.mjs round-submit word-grid:1.0.0:2026-11-09
Remove-Item Env:VERUS_OPERATOR_ACK
```

Step 3 — wait for one confirmation (about a minute on VRSCTEST) and open the
round. Repeat until `roundStatus` is `open`; the server only accepts play for
rounds that are `open` with a confirmed `commitmentTxid`.

```powershell
$env:VERUS_OPERATOR_ACK = 'OPEN_VRSCTEST_ROUND'
node scripts/operator/round-lifecycle.mjs round-open word-grid:1.0.0:2026-11-09
Remove-Item Env:VERUS_OPERATOR_ACK
```

Only one Daily round should be open at a time. The server serves the earliest
round that has not closed yet, so create tomorrow's round at most one day
ahead. The commitment overwrites the previous value under the commitment VDXF
key on `Arcade@`; the history remains on chain.

If `round-create` fails after the round was inserted (for example the daemon
refused to sign), the round is stuck with a failed journal. Use another date or
remove the round from the database; the CLI will not silently re-sign.

## 1. Inspect

Inspection is read-only and requires no acknowledgement:

```powershell
node scripts/operator/round-lifecycle.mjs inspect word-grid:1.0.0:2026-07-27
```

Check `roundStatus`, `closesAt`, the confirmed commitment, the result and
reveal states, and that `hiddenDefinitionPresent` remains `true`. The CLI never
prints the hidden definition.

## 2. Finalize

After the close time:

```powershell
$env:VERUS_OPERATOR_ACK = 'FINALIZE_VRSCTEST_ROUND'
node scripts/operator/round-lifecycle.mjs finalize word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

Finalization freezes eligible scores and creates the deterministic result
Merkle root. It does not broadcast a transaction. Inspect again and verify the
result root.

## 3. Publish results

Prepare the signed, non-broadcast transaction:

```powershell
$env:VERUS_OPERATOR_ACK = 'PREPARE_VRSCTEST_RESULTS_RETURNTX'
node scripts/operator/round-lifecycle.mjs results-prepare word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

Review the journal, then submit explicitly:

```powershell
$env:VERUS_OPERATOR_ACK = 'SUBMIT_VRSCTEST_RESULTS'
node scripts/operator/round-lifecycle.mjs results-submit word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

Reconcile until confirmed:

```powershell
$env:VERUS_OPERATOR_ACK = 'RECONCILE_VRSCTEST_RESULTS'
node scripts/operator/round-lifecycle.mjs results-reconcile word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

Do not continue while the result journal is signed, submitted, missing, or
failed. Reveal preparation requires a confirmed `resultsTxid`.

## 4. Publish the reveal

Only after result confirmation:

```powershell
$env:VERUS_OPERATOR_ACK = 'PREPARE_VRSCTEST_REVEAL_RETURNTX'
node scripts/operator/round-lifecycle.mjs reveal-prepare word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

Verify locally that the definition hashes to the original commitment, then
submit:

```powershell
$env:VERUS_OPERATOR_ACK = 'SUBMIT_VRSCTEST_REVEAL'
node scripts/operator/round-lifecycle.mjs reveal-submit word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

Reconcile until confirmed:

```powershell
$env:VERUS_OPERATOR_ACK = 'RECONCILE_VRSCTEST_REVEAL'
node scripts/operator/round-lifecycle.mjs reveal-reconcile word-grid:1.0.0:2026-07-27
Remove-Item Env:VERUS_OPERATOR_ACK
```

## 5. Verify public evidence

After confirmation:

1. Record both publication transaction IDs.
2. Fetch the public proof and leaderboard APIs.
3. Verify a result Merkle proof in an independent browser session.
4. Verify the reveal hash against the original commitment.
5. Confirm that the leaderboard displays `chain-verified`.
6. Record evidence without credentials, signed payloads, or pre-reveal secrets.

## Recovery

- Preparation is journaled and can be inspected before submission.
- Submission retries reuse the signed journal instead of creating a transaction.
- Reconciliation is safe to repeat while waiting for confirmations.
- On failure, preserve the database and journal, then diagnose the recorded error.
- Never prepare a reveal to work around unconfirmed results. Both transactions
  update the same identity and must remain sequential.
