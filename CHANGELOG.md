# Changelog

All notable changes to this project will be documented in this file.

## [2.3.0] - 2026-03-19

### Added
- **Password-Store Integration** — Use `!pass` references for API keys stored in [password-store](https://www.passwordstore.org/)
- **Pass Entry Discovery** — `/ha` UI automatically discovers matching pass entries and shows them as one-click options
- **Masked API Key Input** — API keys are masked in the UI, with a hint for `!pass` syntax
- New `secrets.ts` module with `resolveSecret`, `credValueMatches`, `findPassEntries` functions
- `credValueMatches` handles mixed resolved/`!pass` credential comparison

## [2.2.0] - 2026-03-19

### Added
- **`--ha-group` CLI Flag** — Specify which HA group to use per session, overriding `defaultGroup` in `ha.json`
- **Network Error Handling** — Detects transient network errors (connection resets, timeouts, internal network failures) with separate configuration
- `networkErrorAction` and `networkRetryDelayMs` settings for network-specific error handling
- Network error settings exposed in `/ha` UI under Settings

### Changed
- Network errors default to `retry` action after 1 second (vs 5 minutes for quota/capacity errors)
- Credentials are no longer marked as exhausted for network errors (transient infrastructure issues)

## [2.1.0] - 2026-02-25

### Added
- **Configurable Error Handling** — Control how the extension responds to capacity vs quota errors
- `capacityErrorAction` setting for provider-level errors (affects all accounts)
- `quotaErrorAction` setting for account-level errors (switching may help)
- `retryTimeoutMs` setting for retry delay configuration

### Changed
- Improved error detection distinguishes between capacity and quota errors

## [2.0.0] - 2026-02-24

### Added
- **Unified HA Manager UI** (`/ha`) — Interactive TUI with accordion-style navigation
- **Group Management** — Create custom failover chains with keyboard navigation
- **Credential Management** — Auto-sync from `/login`, add API keys, manage account priority
- **Multi-Tier Failover** — Account-level failover followed by provider-level failover
- **Exhaustion Tracking** — Intelligent cooldown management for exhausted credentials
- **Dynamic Provider Discovery** — Auto-detects all supported Pi providers
- **Smart Error Detection** — Distinguishes quota, capacity, and network errors
- **Gemini Awareness** — Waits for Google's internal retry attempts before failover

### Keyboard Navigation
- `↑`/`↓` navigate, `Space`/`→` toggle, `Enter` select
- `x`/`d`/`Delete` delete with confirmation
- `u`/`d` reorder items
- `Esc` cancel/exit