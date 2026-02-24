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

Or manually create `~/.pi/ha.json`:

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
  "defaultCooldownMs": 3600000,
  "customProviders": []
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

To use multiple accounts with the same provider (e.g., two Google accounts), register custom providers:

```json
{
  "customProviders": [
    {
      "id": "ha-gemini-backup-1",
      "name": "Google Gemini (Backup Account 1)",
      "mirrors": "google-gemini-cli",
      "api": "google-generative-ai",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "oauth": {
        "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenUrl": "https://oauth2.googleapis.com/token",
        "clientId": "YOUR_CLIENT_ID_HERE",
        "redirectUri": "http://localhost:8085",
        "scopes": "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform"
      }
    }
  ]
}
```

Then add to your group:

```json
{
  "entries": [
    { "id": "google-gemini-cli/gemini-1.5-pro" },
    { "id": "ha-gemini-backup-1/gemini-1.5-pro" }
  ]
}
```

### Setting Up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the **Generative Language API**
4. Go to **APIs & Services** → **Credentials**
5. Click **Create Credentials** → **OAuth client ID**
6. Select **Desktop app** as the application type
7. Copy the Client ID to your `ha.json`

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `/ha-init` | Create a default `~/.pi/ha.json` configuration |
| `/ha-use <group>` | Switch to a different failover group |
| `/ha-status` | Show active group and exhausted providers |

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
2. **Mark Exhausted**: Current provider is marked with a cooldown timestamp
3. **Find Next**: Extension scans the group for the next available provider
4. **Switch**: Calls `pi.setModel()` to change to the new provider
5. **Notify**: Shows you a message: "⚠️ Quota hit on anthropic! Switching to google..."
6. **Retry**: Automatically resends your last message using `pi.sendUserMessage()`

### Loop Prevention

- Each provider is only tried **once per message**
- Cooldown prevents reusing exhausted providers (default: 1 hour)
- If all providers are exhausted, you get an error message

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
2. Marks `google-gemini-cli/gemini-1.5-pro` as exhausted
3. Finds next entry: `openai/gpt-4o`
4. Switches and retries

**OpenAI**: ✅ "This regex pattern uses lookahead assertions..."

### Scenario 3: Multiple OAuth Accounts

**You**: "Generate unit tests for this function"

**Primary Google Account**: ❌ Error: 429 - Quota exceeded

**Extension**:
1. Marks primary account as exhausted
2. Finds next entry: `ha-gemini-backup-1/gemini-1.5-pro`
3. Switches to backup OAuth account
4. Retries your message

**Backup Google Account**: ✅ "Here are comprehensive unit tests..."

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
- Check that `~/.pi/ha.json` exists
- Verify the JSON syntax is valid: `cat ~/.pi/ha.json | python -m json.tool`
- Check pi's extension loading logs

### Failover not triggering
- Run `/ha-status` to see current state
- Check if error message matches known patterns (see Error Detection section)
- Verify you have authentication for fallback providers

### OAuth login not working
- Verify your `clientId` is correct
- Check that the redirect URI matches your OAuth app settings
- Ensure the API is enabled in your cloud console

### All providers exhausted
- Wait for cooldown period to expire (default: 1 hour)
- Restart pi to reset in-memory cooldowns
- Add more providers to your group

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 🙏 Credits

Built for the [pi coding agent](https://github.com/mariozechner/pi) community.
