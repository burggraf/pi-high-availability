# pi-high-availability 🔄

**pi-high-availability** automatically switches to fallback LLM providers when your primary provider hits quota limits or capacity constraints. Never get stuck waiting for quota resets again.

## ✨ Features

- **Automatic Failover**: Detects quota exhaustion (429 errors) and capacity constraints, then seamlessly switches to backup providers
- **User-Defined Priority Groups**: Create custom failover chains (e.g., "Pro" → "Fast" → "Cheap")
- **Multiple OAuth Accounts**: Automatically stores multiple OAuth credentials for the same provider
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

## 🔐 Multiple OAuth Accounts

The extension automatically stores OAuth credentials in `~/.pi/agent/ha.json` and can switch between them during failover.

### How It Works

When you run `/login` and authenticate with an OAuth provider:
1. The extension automatically syncs the credential from `auth.json` to `ha.json`
2. If the credential is new (different from existing ones), it's stored with a unique name
3. During failover, the extension can switch between these stored credentials

### Adding a Backup OAuth Account

**Scenario**: You have one Google account set up. You want to add a second.

```bash
# 1. Check current credentials
/ha-status

# 2. Run /login and authenticate with your second account
/login
# (Select Google Cloud Code Assist, login with backup Google account)

# 3. Sync the new credential to ha.json
/ha-sync

# 4. Verify both credentials are stored
/ha-status
```

The output will show:
```
OAuth credentials stored:
  google-gemini-cli: primary, backup-1 (active: primary)
```

### Manual Credential Switching

To manually switch which OAuth credential is active:

```bash
/ha-switch google-gemini-cli backup-1
```

This swaps the credential in `auth.json` so you can test different accounts.

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `/ha-init` | Create a default `~/.pi/agent/ha.json` configuration |
| `/ha-use <group>` | Switch to a different failover group |
| `/ha-status` | Show active group, exhausted providers, and stored OAuth credentials |
| `/ha-sync` | Sync OAuth credentials from `auth.json` to `ha.json` |
| `/ha-switch <provider> <name>` | Manually switch to a specific OAuth credential |

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
2. **Try Next OAuth Credential**: If multiple OAuth credentials exist for the provider, switch to the next one
3. **Mark Exhausted**: If no more OAuth credentials, mark the provider as exhausted
4. **Find Next Provider**: Scan the group for the next available provider
5. **Switch**: Calls `pi.setModel()` to change to the new provider
6. **Notify**: Shows you a message: "⚠️ Quota hit on anthropic! Switching to google..."
7. **Retry**: Automatically resends your last message using `pi.sendUserMessage()`

### Loop Prevention

- Each provider/OAuth combination is only tried **once per message**
- Cooldown prevents reusing exhausted providers (default: 1 hour)
- If all providers and OAuth credentials are exhausted, you get an error message

## 📊 Example Scenarios

### Scenario 1: OAuth Backup Chain

**You**: "Generate unit tests for this function"

**Primary Google Account**: ❌ Error: 429 - Quota exceeded

**Extension**:
1. Detects multiple OAuth credentials for `google-gemini-cli`
2. Switches to `backup-1` credential
3. Retries your message

**Backup Google Account**: ✅ "Here are comprehensive unit tests..."

### Scenario 2: Provider Failover

**You**: "Refactor this authentication module"

**Anthropic**: ❌ Error: 429 - You exceeded your current quota

**Extension**:
1. No more OAuth credentials for Anthropic
2. Marks `anthropic/claude-3-5-sonnet` as exhausted
3. Finds next entry: `google-gemini-cli/gemini-1.5-pro`
4. Switches model
5. Retries your message

**Google**: ✅ "Here's the refactored authentication module..."

### Scenario 3: Google Gemini Capacity

**You**: "Explain this regex pattern"

**Gemini**: ⚠️ No capacity available for model gemini-1.5-pro

**Gemini** (internal retry 1): ⚠️ No capacity available...

**Gemini** (internal retry 2): ⚠️ No capacity available...

**Gemini** (final): ❌ Retry failed after 3 attempts

**Extension**:
1. Waits for final "Retry failed" message
2. Switches to backup OAuth credential
3. Retries with backup account

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

### OAuth credentials not syncing
- Run `/ha-sync` manually after `/login`
- Check that `~/.pi/agent/ha.json` has an `oauth` section
- Verify credentials are different (different refresh tokens)

### All providers exhausted
- Wait for cooldown period to expire (default: 1 hour)
- Restart pi to reset in-memory cooldowns
- Add more providers or OAuth credentials to your group

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 🙏 Credits

Built for the [pi coding agent](https://github.com/mariozechner/pi) community.
