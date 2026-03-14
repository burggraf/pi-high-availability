# Task Plan: Pi High Availability Extension

## PRs

### PR 1: Fix ha-mock-error (`fix/ha-mock-error`)
- **Branch**: `fix/ha-mock-error` (from `main`)
- **Status**: committed, ready to push
- **Changes**: `extensions/index.ts` — rewrite `ha-mock-error` to directly call `switchCred` instead of sending a message to the model
- **Why**: Old version sent `MOCK_FAILOVER_TRIGGER` as a user message that reached the model; `turn_start` can't cancel in-flight turns

### PR 2: Pass entry discovery UI (`feat/pass-discovery`)
- **Branch**: `feat/pass-discovery` (from `fix/ha-mock-error`)
- **Depends on**: PR 1
- **Status**: committed, ready to push
- **Changes**:
  - `extensions/secrets.ts` — new file: `resolveSecret`, `credValueMatches`, `findPassEntries`
  - `extensions/index.ts` — use `credValueMatches` in `syncAuthToHa` + `updateActiveCredentialsFromAuth` for mixed resolved/`!pass` comparison
  - `extensions/ui/HaUi.ts` — pass entry one-click discovery, `credValueMatches` in UI state, masked API key input, `!pass` hint
- **Why**: Supports `!pass` references in credentials; surfaces matching password store entries in the UI

### PR 3: Per-entry model+params (`feat/entry-model-params`)
- **Branch**: `feat/entry-model-params` (from `feat/pass-discovery`)
- **Depends on**: PR 2
- **Status**: planned
- **Changes**:
  - Extend `HaGroupEntry` with `model?`, `thinkingLevel?`, `temperature?`
  - Apply model params when failing over via `pi.setModel`
  - Update UI to configure per-entry model settings
- **Why**: Allows caste-based groups (scout/worker/soldier) to specify different models and params per provider entry

## Testing Checklist
- [x] `/ha-mock-error` switches credential (PR1)
- [x] `/ha-status` shows correct active credential
- [x] `!pass` refs written to auth.json as-is (pi resolves at API call time)
- [ ] `findPassEntries` surfaces matching pass paths in UI (PR2)
- [ ] Per-entry model override applied on failover (PR3)
- [ ] Cross-provider failover: openrouter → chutes → anthropic
- [ ] Cooldown behavior across credentials and providers

## Architecture Notes
- auth.json should contain `!pass` refs, not resolved values — pi resolves at API call time
- `credValueMatches` handles mixed case (one side resolved, one side `!pass` ref)
- `updateActiveCredentialsFromAuth` is duplicated in index.ts and HaUi.ts — deduplicate in PR2 or future cleanup
