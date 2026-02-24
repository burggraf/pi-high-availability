# Task Plan: High Availability Extension for Pi

## Goal
Create a High Availability extension for pi that automatically switches to a fallback model/provider when a quota is hit, using user-defined priority groups in `~/.pi/ha.json`, and automatically resends the last message once per provider.

## Current Phase
Phase 1: Requirements & Discovery

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent (Informed Retry, User-defined Groups, informed notifications)
- [x] Identify constraints and requirements (Auth integration, 429 detection, cooldowns)
- [x] Document findings in findings.md
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Define `ha.json` schema
- [x] Define extension architecture (hooks, state management, custom provider registration)
- [x] Create project structure
- **Status:** complete

### Architecture Decisions
- **Custom Provider Registration**: Use `pi.registerProvider()` to create backup OAuth identities (e.g., `ha-gemini-backup-1`)
- **OAuth Isolation**: Each backup account gets its own `/login` command and credential storage
- **Model Mirroring**: Dynamically clone model definitions from original providers to custom providers

### Phase 3: Implementation
- [x] Create extension directory structure
- [x] Implement `ha.json` loader and group management
- [x] Implement custom provider registration for backup OAuth accounts
- [x] Implement `/ha-use` command
- [x] Implement `/ha-status` command
- [x] Implement `turn_end` hook for error detection
- [x] Implement switching logic (cooldowns, cycling)
- [x] Implement retry logic (notification + switch + resend)
- [x] Implement capacity error detection
- [x] Add Google Gemini-specific "Retry failed" logic
- **Status:** complete

### Files Created
- `~/.pi/agent/extensions/ha-provider/index.ts` - Main extension code
- `~/.pi/agent/extensions/ha-provider/ha.json.example` - Example configuration
- `~/.pi/agent/extensions/ha-provider/README.md` - Documentation
- `~/.pi/agent/extensions/ha-provider/package.json` - Package manifest
- `~/.pi/agent/extensions/ha-provider/tsconfig.json` - TypeScript config

### Phase 4: Testing & Verification
- [ ] Verify group switching
- [ ] Verify error detection (mock 429)
- [ ] Verify failover and resend
- [ ] Verify cooldown behavior
- **Status:** pending

### Phase 5: Delivery
- [ ] Final code review
- [ ] Create README for the extension
- [ ] Deliver to user
- **Status:** pending

## Key Questions
1. How to reliably detect a "quota exceeded" error across all providers? (Research suggests 429/Resource Exhausted)
2. How to trigger a resend from an extension? (Use `pi.sendUserMessage`)
3. How to persist "exhausted" state across sessions if needed? (Start with in-memory, maybe move to file)

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use `~/.pi/ha.json` | Persistent, user-controllable configuration |
| Hook into `turn_end` | Allows inspecting the assistant's message for error codes/messages |
| Use `pi.setModel` | Built-in way to change the active model and resolve auth |
| Cooldown default 1h | Balance between trying again and avoiding repeated failures |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |

## Notes
- Ensure `ha.json` is optional or has sensible defaults
- Notifications should be clear but not intrusive
