# pi-high-availability 🔄

**pi-high-availability** automatically switches to fallback LLM providers when your primary provider hits quota limits or capacity constraints. Never get stuck waiting for quota resets again.

## ✨ Features

- **Automatic Failover**: Detects quota exhaustion (429 errors) and capacity constraints, then seamlessly switches to backup providers
- **User-Defined Priority Groups**: Create custom failover chains (e.g., "Pro" → "Fast" → "Cheap")
- **Multiple OAuth Accounts**: Register backup OAuth credentials for the same provider (e.g., two Google accounts)
- **Smart Error Detection**: Distinguishes between quota errors, rate limits, and capacity constraints
- **Google Gemini Aware**: Waits for Gemini's internal retries to complete before failing over
- **Cooldown Management**: Temporarily skips exhausted providers (default: 1 hour, configurable)
- **Automatic Retry**: Resends your last message after switching providers
- **Loop Prevention**: Ensures each provider is only tried once per message

## 🚀 Quick Start

### 1. Install the Extension

```bash
pi install npm:pi-high-availability
```

### 2. Create Configuration File

```bash
# Create the config file
pi -e pi-high-availability
# Then run: /ha-init
```

Or manually create `~/.pi/agent/ha.json`:

```json
{
  "groups": {
    "pro": {
      "name": "Professional Tier",
      "entries": [
        { "id": "anthropic/claude-3-5-sonnet" },
        { "id": "google-gemini-cli/gemini-1.5-pro" },
        { "id": "openai/gpt-4o" }
      ]
    }
  },
  "defaultGroup": "pro",
  "defaultCooldownMs": 3600000
}
```

### 3. Use pi Normally

Start coding! If your primary provider hits quota, the extension automatically switches to the next one.

## 📋 Configuration Guide

### Basic Structure

```json
{
  "groups": {
    "<group-name>": {
      "name": "Display Name",
      "entries": [
        { "id": "provider/model-id", "cooldownMs": 3600000 },
        { "id": "provider" }
      ]
    }
  },
  "defaultGroup": "<group-name>",
  "defaultCooldownMs": 3600000
}
```

### Entry Formats

Entries can be specified in two ways:

1. **Provider + Model** (recommended): `"anthropic/claude-3-5-sonnet"`
2. **Provider Only**: `"anthropic"` (uses first available model from that provider)

### Per-Entry Cooldown

Override the global cooldown for specific entries:

```json
{
  "id": "anthropic/claude-3-5-sonnet",
  "cooldownMs": 1800000
}
```

### Multiple Groups

Create different groups for different use cases:

```json
{
  "groups": {
    "pro": {
      "name": "Best Quality",
      "entries": [
        "anthropic/claude-3-5-sonnet",
        "google-gemini-cli/gemini-1.5-pro",
        "openai/gpt-4o"
      ]
    },
    "fast": {
      "name": "Fast & Cheap",
      "entries": [
        "google-gemini-cli/gemini-1.5-flash",
        "groq/llama-3.1-70b",
        "anthropic/claude-3-haiku"
      ]
    },
    "coding": {
      "name": "Coding Optimized",
      "entries": [
        "anthropic/claude-3-5-sonnet",
        "openai/gpt-4o",
        "google-gemini-cli/gemini-1.5-pro"
      ]
    }
  },
  "defaultGroup": "pro"
}
```

## 🔐 Multiple OAuth Accounts

Pi only supports one OAuth credential per provider. To use multiple accounts with the same provider (e.g., two Google accounts), the HA extension provides a backup OAuth system.

### How It Works

The extension stores backup OAuth credentials in `~/.pi/agent/ha-oauth.json`, separate from pi's main `auth.json`. When you need to fail over, it swaps the credentials for you.

### Setting Up a Backup OAuth Account

**Scenario**: You're logged into Google Gemini with your primary account. You want to add a backup account.

#### Step 1: Save Current Credentials as "primary"

```bash
/ha-backup-create google-gemini-cli primary
```

This saves your current credentials as "primary" and clears them from `auth.json` so you can re-authenticate.

#### Step 2: Authenticate with Backup Account

```bash
/login
```

Select "Google Cloud Code Assist (Gemini CLI)" and complete the OAuth flow with your **backup** Google account.

#### Step 3: Capture the Backup Credentials

```bash
/ha-backup-capture google-gemini-cli backup-1
```

This:
1. Saves the new credentials as "backup-1" in `ha-oauth.json`
2. Restores your primary credentials to `auth.json`

You're now back to using your primary account, but the backup is stored for failover.

### Managing OAuth Backups

| Command | Description |
|---------|-------------|
| `/ha-backup-create <provider> <name>` | Save current credentials and prepare for re-auth |
| `/ha-backup-capture <provider> <name>` | Capture new credentials and restore primary |
| `/ha-backup-switch <provider> <name>` | Manually switch to a backup account |
| `/ha-backup-list <provider>` | List all backups for a provider |

### Automatic Failover with Backups

When your primary OAuth account hits quota:

1. Extension detects the quota error
2. Automatically switches to an unused backup account
3. Retries your message
4. Notifies you: `"⚠️ Quota hit on google-gemini-cli! Switched to backup account 'backup-1'. Retrying..."`

### Example: Complete OAuth Backup Setup

```bash
# You're already logged in with your primary Google account

# 1. Save primary credentials
/ha-backup-create google-gemini-cli primary

# 2. Authenticate with backup account
/login
# (Select Google Cloud Code Assist, login with backup Google account)

# 3. Capture backup credentials
/ha-backup-capture google-gemini-cli backup-1

# 4. (Optional) Add more backups
/ha-backup-create google-gemini-cli backup-1  # Save current (primary)
/login  # Authenticate with third account
/ha-backup-capture google-gemini-cli backup-2

# 5. Check your backups
/ha-backup-list google-gemini-cli
# Output:
#   primary (2026-02-24)
#   backup-1 (2026-02-24)
#   backup-2 (2026-02-24)
```

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `/ha-init` | Create a default `~/.pi/agent/ha.json` configuration |
| `/ha-use <group>` | Switch to a different failover group |
| `/ha-status` | Show active group, exhausted providers, and OAuth backups |
| `/ha-backup-create <provider> <name>` | Save current OAuth and prepare for re-auth |
| `/ha-backup-capture <provider> <name>` | Capture new OAuth credentials as backup |
| `/ha-backup-switch <provider> <name>` | Manually switch to a backup OAuth account |
| `/ha-backup-list <provider>` | List OAuth backups for a provider |

## 🔍 How It Works

### Error Detection

The extension detects two categories of errors:

#### 1. Quota/Rate Limit Errors (trigger immediately)
- HTTP 429 (Too Many Requests)
- "quota exceeded"
- "resource exhausted"
- "rate limit" / "rate_limit"
- "exceeded_current_quota"
- "insufficient quota"

#### 2. Capacity Errors (provider-side resource exhaustion)

| Provider | Error Pattern | Behavior |
|----------|--------------|----------|
| **Google Gemini** | `No capacity available` → `Retry failed after N attempts` | **Only triggers on final "Retry failed" message** (Gemini retries internally) |
| **Anthropic Claude** | `Due to unexpected capacity constraints` | Triggers immediately |
| **Moonshot** | `Engine Overloaded` | Triggers immediately |
| **OpenAI/Groq** | `429 Too Many Requests` (capacity-related) | Triggers immediately |

### Failover Flow

1. **Error Detected**: Extension sees a quota/capacity error in the `turn_end` hook
2. **Try OAuth Backup First**: If backups exist for the current provider, switch to an unused one
3. **Mark Exhausted**: Current provider/backup is marked with a cooldown timestamp
4. **Find Next**: Extension scans the group for the next available provider
5. **Switch**: Calls `pi.setModel()` to change to the new provider
6. **Notify**: Shows you a message: "⚠️ Quota hit on anthropic! Switching to google..."
7. **Retry**: Automatically resends your last message using `pi.sendUserMessage()`

### Loop Prevention

- Each provider/backup combination is only tried **once per message**
- Cooldown prevents reusing exhausted providers (default: 1 hour)
- If all providers and backups are exhausted, you get an error message

## 📊 Example Scenarios

### Scenario 1: Anthropic Quota Exhausted

**You**: "Refactor this authentication module"

**Anthropic**: ❌ Error: 429 - You exceeded your current quota

**Extension**:
1. Marks `anthropic/claude-3-5-sonnet` as exhausted
2. Finds next entry: `google-gemini-cli/gemini-1.5-pro`
3. Switches model
4. Notifies: "⚠️ Quota hit on anthropic! Switching to google..."
5. Retries your message

**Google**: ✅ "Here's the refactored authentication module..."

### Scenario 2: Google Gemini Capacity

**You**: "Explain this regex pattern"

**Gemini**: ⚠️ No capacity available for model gemini-1.5-pro

**Gemini** (internal retry 1): ⚠️ No capacity available...

**Gemini** (internal retry 2): ⚠️ No capacity available...

**Gemini** (final): ❌ Retry failed after 3 attempts

**Extension**:
1. Waits for final "Retry failed" message (ignores intermediate warnings)
2. Checks for OAuth backups: Found "backup-1"
3. Switches to backup account
4. Retries with backup account

**Gemini (backup)**: ✅ "This regex pattern uses lookahead assertions..."

### Scenario 3: OAuth Backup Chain

**You**: "Generate unit tests for this function"

**Primary Google Account**: ❌ Error: 429 - Quota exceeded

**Extension**:
1. Switches to "backup-1" OAuth account
2. Retries message

**Backup-1 Google Account**: ❌ Error: 429 - Quota exceeded

**Extension**:
1. Switches to "backup-2" OAuth account
2. Retries message

**Backup-2 Google Account**: ✅ "Here are comprehensive unit tests..."

## ⚙️ Advanced Configuration

### Custom Cooldown Periods

```json
{
  "groups": {
    "pro": {
      "entries": [
        { "id": "anthropic/claude-3-5-sonnet", "cooldownMs": 3600000 },
        { "id": "google-gemini-cli/gemini-1.5-pro", "cooldownMs": 1800000 },
        { "id": "openai/gpt-4o", "cooldownMs": 7200000 }
      ]
    }
  },
  "defaultCooldownMs": 3600000
}
```

### Provider-Only Entries

If you don't care about the specific model:

```json
{
  "entries": [
    { "id": "anthropic" },
    { "id": "google-gemini-cli" },
    { "id": "openai" }
  ]
}
```

The extension will use the first available model from each provider.

## 🐛 Troubleshooting

### Extension not loading
- Check that `~/.pi/agent/ha.json` exists
- Verify the JSON syntax is valid: `cat ~/.pi/agent/ha.json | python -m json.tool`
- Check pi's extension loading logs

### Failover not triggering
- Run `/ha-status` to see current state
- Check if error message matches known patterns (see Error Detection section)
- Verify you have authentication for fallback providers

### OAuth backup not working
- Run `/ha-backup-list <provider>` to verify backup exists
- Check `~/.pi/agent/ha-oauth.json` exists and has your backup
- Ensure you completed both `/ha-backup-create` and `/ha-backup-capture` steps

### All providers exhausted
- Wait for cooldown period to expire (default: 1 hour)
- Restart pi to reset in-memory cooldowns
- Add more providers or OAuth backups to your group

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 🙏 Credits

Built for the [pi coding agent](https://github.com/mariozechner/pi) community.
