## Why

After a game hop, the current continuation flow only supports starting another gaming session. Some customers instead want to remain on a consumables tab after the game ends, while still carrying their previous unbilled game charges forward into the eventual checkout.

## What Changes

- Add a post-hop continuation choice in the existing start modal, defaulting to gaming.
- Allow staff to choose a consumables continuation that reuses the existing customer tab flow.
- Prefill the consumables continuation with the hopped customer's details.
- When checking out a customer tab, surface matching unbilled hopped game sessions preselected for inclusion.
- Allow staff to exclude previous hopped sessions from the customer-tab bill; excluded sessions remain unbilled for later.
- Preserve the existing line labels and billing/discount behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-game-hop`: Extend the hop continuation and combined billing behavior so a hopped game can continue into an existing customer tab checkout path.

## Impact

- `src/App.tsx`: post-hop modal state, customer-tab creation from hop, checkout-state initialization, combined line construction, and checkout UI selection.
- `src/types.ts`: any additional local state/type support needed for post-hop continuation mode.
- `src/utils.ts` and `src/utils.test.ts`: helper coverage for customer-tab combined billing behavior if extracted or expanded.
- `openspec/changes/hop-to-consumables-tab/specs/session-game-hop/spec.md`: requirement deltas for the existing hop capability.
