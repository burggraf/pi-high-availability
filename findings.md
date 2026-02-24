# Findings & Decisions: Pi High Availability Extension

## Requirements
- **Configuration**: JSON file `~/.pi/ha.json`.
- **Groups**: User defines groups of providers/models with priority.
- **Activation**: `/ha-use <group>` to switch; default group on startup.
- **Granularity**: Entries can be `provider/model-id` or just `provider`.
- **Failover Logic**:
  - Detect HTTP 429, "quota exceeded", "Resource exhausted", "rate_limit".
  - Track exhausted items with a cooldown (default 1h, user-overridable).
  - Cycle through the active group's priority list.
  - Stop at the end of the list.
- **Action**:
  - Notify user ("Provider X quota hit! Switching to Y...").
  - Switch model via `pi.setModel`.
  - Automatically resend last user message (once per provider to avoid loops).
- **Auth**: Must work with `auth.json` (API keys and OAuth).

## Research Findings
- **Error Detection**: Providers use 429 or specific error strings like `RESOURCE_EXHAUSTED` (Gemini), `rate_limit_error` (Anthropic), `exceeded_current_quota_error` (Moonshot).
- **Extension API**: 
  - `pi.setModel(model)` returns `Promise<boolean>` (false if no auth).
  - `pi.sendUserMessage(content, options)` can trigger a new turn.
  - `turn_end` event provides `event.message.errorMessage`.
  - `ctx.modelRegistry.getAvailable()` lists all models available via `models.json` and `auth.json`.
- **OAuth**: `pi.setModel` handles token refresh automatically if configured in `auth.json`.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| `ha.json` structure | `{ "groups": { "coding": ["anthropic", "google/gemini-1.5-pro"] }, "defaults": { "cooldown": 3600 } }` |
| Cooldown Tracking | Store `exhaustedAt` timestamps in a Map indexed by `provider` or `provider/model`. |
| Error Matching | Regex or substring search on `errorMessage` in `turn_end`. |
| Loop Prevention | Store a `lastRetryMessage` hash or timestamp to ensure we don't retry the same thing on the same provider twice. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
|       |            |

## Resources
- pi Extension Docs: `/Users/markb/.nvm/versions/node/v24.11.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- pi AI Types: `/Users/markb/.nvm/versions/node/v24.11.0/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/types.d.ts`

## Visual/Browser Findings
- Anthropic ratelimits: RPM/TPM based on tier.
- Gemini Free Tier: Very low TPM for Pro models.
- Moonshot: TPM based on `max_tokens` parameter.
