# Continuation billed-disposition test correction

## Evidence and scope

The immutable staging run `normops-20261009-1410-acceptance-7ded209` stopped with four passed, one failed, twenty-six not run and zero retries. Unit-sale start, hop and checkout succeeded; the next assertion expected `hopped` although the stored session was `billed` with the confirmed bill ID. Database reconciliation found no live residue and exact unchanged compatibility state/functions; temporary roles were disabled and the staging baseline restored.

Current `src/App.tsx` sets both primary and carried sessions to `billed` when assigning the confirmed bill ID. `supabase/phase10-financial-v2-rpcs.sql` validates that disposition and writes it to normalized columns and raw data. Before checkout, the hop remains `hopped` with a null bill ID. No product semantics change is required.

## Change

Correct three after-checkout expectations: `billRecoverableSource` and the unit-sale test in `operational-lifecycle-v2-continuations.e2e.ts`, plus the same stale assertion found by independent broader review in `operational-lifecycle-v2-hop-mutation-races.e2e.ts`. Preserve the pre-checkout hopped/null assertion, exact bill linkage, item parity, one-time stock changes, receipt/reload checks, test identities, budgets, zero retries and all safeguards.

An independently authored offline source-contract test checks all three corrected assertions, their agreement with application/SQL source, retention of downstream assertions, and the currently used operational-spec literal patterns for inconsistent hopped/non-null bill pairs. The pattern scan is not full AST or runtime coverage. Source checks do not execute transactions or prove UI behavior. The failed run is preserved, not retried or relabeled as passed.

## Gates

1. Independent source review and offline regression execution.
2. Freeze the clean successor and verify the product/SQL diff is empty.
3. Obtain exact-candidate independent local test/review verdicts.
4. Fresh staging identity and all required source/proof/deployment preflights before the unchanged reusable Playwright suite. Do not reuse historical proof results as fresh execution.
5. Immediate reconciliation, role deactivation, staging restoration and independent actual-results review, even on failure.

Production remains excluded without immediate explicit approval. This document is a plan, not evidence that these gates passed.
