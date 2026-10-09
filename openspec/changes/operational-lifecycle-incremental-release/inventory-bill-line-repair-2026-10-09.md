# Inventory bill-line oracle correction

## Observed failure, not a product change

Immutable run `normops-20261009-1600-acceptance-44ba0f1` ended 4 passed, 1 failed, 26 not run, zero retries. The unit-sale test filtered bill_lines by linked_session_id, then expected a standalone inventory line. Exact read-only staging evidence confirmed the source item and canonical/persisted bill line: Arcade 1 Coin, quantity 1, INR5, linked_session_id NULL; cash payment INR5 and one stock movement -1. Both independent agents confirmed the query excluded a valid line. App/SQL intentionally omit that session link for non-combo inventory lines.

The source session was correctly closed/billed with the exact bill. Posttest operational floors/residuals were zero, compatibility state/functions unchanged, roles disabled, staging fallback restored. The failed run remains failed and is never replayed.

## Narrow correction

- Read all lines by exact organization and bill ID in unit-sale continuation and hop-mutation races; do not filter by session linkage.
- Preserve source-to-bill and stock assertions. Assert NULL session links for these non-combo fixtures.
- Compare the complete inventory set in every hop-race subcase, including quantity, price, inventory item, sale variant, pack size and derived pack description. Preserve separate mutation-outcome assertions.
- Capture queried rows before assertions, so a failure retains useful diagnostics without another live mutation.
- Independently test real checkout utility output for plain and packed-variant lines, malformed persisted evidence, and both query source contracts. Offline contract tests are not live acceptance.

No runtime, SQL definitions, billing calculations, business models, performance limits or retry settings change.

## Cost-controlled validation

Use the fixed two-case supplemental gate described in [inventory-contract-supplement.md](inventory-contract-supplement.md). It runs the unit-sale case and the complete five-operation hop-mutation race, before another expensive full31-case run. It retains clean source/runtime bindings, fresh DB proof and preflight, actor checks, exact deployed bundle, immutable evidence, zero retries and postflight/role/fallback closeout. A focused pass is explicitly not full release acceptance.

Required sequence: local regressions and independent source review; freeze exact candidate; independent clean-checkout verification; fresh staging identities/evidence; focused two-case run and separate strict posttest verifier; independent actual-result review; only then fresh full31-case acceptance. Production remains separately approval-gated.
