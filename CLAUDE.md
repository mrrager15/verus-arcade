# Verus Arcade — instructies voor Claude Code

Open-source platform voor kleine dagelijkse games op [Verus](https://verus.io), en tegelijk een showcase van Verus-features. Spelers loggen in met hun VerusID (Verus Mobile). De server bewaakt het spel (scores worden nagerekend, niet overgenomen). Elke ronde krijgt een commitment, resultaten en een reveal op een operator-VerusID, met Merkle-bewijzen en een publieke verifier. Spelers tekenen hun poging en zetten resultaat en attestaties in hun eigen VerusID. Games: **Word Grid** en **Number Target**. Nieuwe games sluiten aan via een contract (`docs/SDK.md`).

**Alleen VRSCTEST.** Mainnet is uitgeschakeld voor ontwikkeling.

Stack: SvelteKit (adapter-node) + Express + SQLite (`node:sqlite`) + verusd JSON-RPC, `verus-typescript-primitives`, `verusid-ts-client`, `verus-connect` (gevendord). Node ≥ 22.13 (CI: Node 22).

## Mappen

| Pad | Inhoud |
| --- | --- |
| `src/` | SvelteKit-UI; bord per game in `src/lib/games/`; routes `profile`, `verify`, `attestations` |
| `server/` | Express-app, API, Daily-service, bewijzen, attestaties, manifesten, nachtcyclus-plan |
| `server/db/` | SQLite-repository en migraties |
| `server/verus/` | Gateway, RPC-client, wallet-verzoeken, spelersrecords, profiel |
| `server/games/` | Puzzelgeneratoren per game |
| `shared/` | Deterministische code voor browser en server (spelregels, Verus-MMR, fixtures) |
| `shared/games/<game>/<versie>/` | `rules.mjs`, `generator.mjs`, `answers.mjs`, `vectors.json`; register in `shared/games/index.mjs` |
| `scripts/operator/` | Operator-commando's (rondes, nachtcyclus, attestaties, manifesten, publicaties), elk met een ACK |
| `scripts/integration/` | Tests tegen een echte VRSCTEST-daemon |
| `scripts/agent/` | Hulpscripts voor Claude: RPC-relay (+ `relay-policy.mjs`), `http-check`, `net-check`, `replay-check` |
| `scripts/storage-poc/` | Experimenten met Verus-opslag |
| `vendor/verus-connect/` | Gevendorde login-bibliotheek. **Niet wijzigen**; uitbreiden met een router ervoor |
| `docs/` | `OPERATOR_RUNBOOK.md`, `SDK.md`, `TECHNICAL_FOUNDATION.md`, ADR's in `docs/adr/` |
| `server/data/` | Runtime: SQLite-database, journals, `daily-cycle.log`, `daily-cycle.lock` (gitignored) |
| `werkmap/` | Privé projectnotities (gitignored; ontbreekt in een verse clone) |

## Commando's

```bash
npm install
npm test                  # unit-tests (node --test, globs in package.json)
npm run check             # svelte-check; controleert ook .mjs (checkJs)
npm run build             # productiebuild in build/; de server serveert die op poort 8100
npm run server:watch      # dev-server, herstart bij gewijzigde servercode of nieuwe build
npm run server:watch -- --test   # idem, met korte testrondes
npm run dev               # Vite op 5173 (alleen localhost)
```

Operator-voorbeelden staan in `docs/OPERATOR_RUNBOOK.md` (rondes: sectie 0–5, publicaties: 6, nachtcyclus: 7, manifesten: 8).

## VRSCTEST-regels (hard)

- **Alleen VRSCTEST.** Nooit mainnet, nooit `ARCADE_NETWORK=vrsc`, nooit een `*MAINNET_ACK` zetten. Nooit geld versturen.
- **`.env` nooit lezen, tonen of committen**: daarin staat de service-WIF. Geen sleutels, seeds of RPC-wachtwoorden in git, logs of notities.
- **Identity-updates één voor één, met bevestiging ertussen.** Twee onbevestigde updates van dezelfde ID geven `bad-txns-inputs-spent`. Alleen `scripts/operator/daily-cycle.mjs` mag er meerdere doen: dat script wacht zelf op elke bevestiging.
- **Niet tijdens de nachtcyclus**: bestaat `server/data/daily-cycle.lock`, dan geen operator-commando's starten.
- Operator-scripts vragen een ACK-variabele (`VERUS_OPERATOR_ACK`, …): nooit omzeilen. Inspecteer een ronde vóór elke stap die iets verandert.
- Testrondes alleen op een aparte test-operator-ID, nooit op de echte operator-ID (`Arcade@`).
- Een verborgen ronde-definitie nooit tonen vóór de reveal bevestigd is.
- De chain is de bron van waarheid: een txid uit de wallet is een ontvangstbewijs (`receipt`); pas na teruglezen met gelijke hash is iets `published`.

## Code-regels

- **Oude rondes blijven verifieerbaar.** Bestaande schema's en regels niet wijzigen; een nieuwe versie toevoegen. Een regelwijziging is een nieuwe gameversie (nieuwe map, nieuw manifest).
- `rules.mjs` heeft geen imports, geen toeval en geen tijd; de hash gaat over de LF-tekst.
- Gedrag bewaren bij een verhuizing of refactor: testvectoren maken met de oude code (`git show master:<pad>`).
- De lokale checkout is ook de draaiende dev-server en de nachtcyclus: **elke commit moet een werkende toestand zijn**. Een nieuw pad eerst voor iets nieuws gebruiken, het bestaande pas omzetten als het nieuwe live bewezen is.
- Frontend draait ook op `http://<LAN-IP>` (geen secure context): gebruik `src/lib/browser-safe.ts`, niet rechtstreeks `crypto.randomUUID` of `navigator.clipboard`.
- Verus Mobile aanvaardt deeplinks tot 2045 tekens: records in wallet-verzoeken compact houden.
- Codecommentaar en commit-boodschappen in het Nederlands.

## Testen

- Na elke wijziging `npm test` en `npm run check`; na een frontendwijziging ook `npm run build`.
- Tests staan naast de code (`*.test.mjs`) en moeten onder een glob van het `test`-script vallen.
- `scripts/integration/` en operator-commando's alleen bewust draaien, op VRSCTEST, met hun ACK.
- Wallet-tests met Verus Mobile doet een mens; beschrijf precies wat die moet doen.

## Branches

- `master` is gemerged en werkend. Werk op één branch per fase (`feat/…`, `chore/…`).
- Eén commit per afgeronde stap, met een duidelijke boodschap. Pushen: `git push origin <branch>`; een nieuwe branch meteen met upstream.
- Mergen naar `master` alleen na uitdrukkelijk akkoord van de eigenaar.

## Relay

`scripts/agent/rpc-relay.mjs` geeft geautomatiseerde taken zonder eigen daemon-toegang (zoals de nachtcyclus) beperkte toegang tot de VRSCTEST-daemon: alleen VRSCTEST, whitelist in `relay-policy.mjs`, geen `updateidentity`/`sendcurrency`/`sendrawtransaction`. Relay-map: `werkmap/.relay` (of `ARCADE_RELAY_DIR`). Status: `node scripts/agent/relay-client.mjs status`.
