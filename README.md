# pi-high-availability 🔄

**pi-high-availability** automatically switches to fallback LLM providers when your primary provider hits quota limits or capacity constraints. Never get stuck waiting for quota resets again.

## ✨ Features

- **Unified HA Manager**: A beautiful interactive TUI (`/ha`) to manage all your groups and credentials in one place.
- **Automatic Multi-Tier Failover**: 
    1. **Account Failover**: Seamlessly switches between multiple accounts for the *same* provider.
    2. **Provider Failover**: Automatically jumps to the next provider in your group if all accounts for the current provider are exhausted.
- **Exhaustion Tracking**: Intelligent cooldown management marks specific accounts or providers as "exhausted" on 429/capacity errors, preventing retries until they recover.
- **Dynamic Provider Discovery**: Automatically detects all supported Pi providers (Anthropic, OpenAI, Gemini, Moonshot, Zai, etc.) without configuration.
- **Group Management**: Create custom failover chains (e.g., "Fast Tier" → "Backup Tier") and rearrange model priority with simple keybindings.
- **Credential Sync & Storage**: Automatically capture OAuth logins or manually add API keys for backup accounts.
- **Smart Error Detection**: Distinguishes between quota errors and transient capacity issues, including full support for Google Gemini's internal retry patterns.

## 🚀 Quick Start

### 1. Install the Extension

```bash
pi install npm:pi-high-availability
```

### 2. Open the Manager

Run the High Availability manager to initialize your configuration:

```bash
/ha
```

### 3. Configure Your First Group

1.  Select **📂 Groups**.
2.  Add or select a group (e.g., `default`).
3.  Add Model IDs (e.g., `anthropic/claude-3-5-sonnet`) to the group.
4.  Use **`u`** and **`d`** keys to rearrange the priority.

## 🎮 The HA Manager (`/ha`)

The interactive manager is your control center for high availability.

### 📂 Group Management
*   **Add/Rename/Delete** groups.
*   **Rearrange Priority**: Use **`u`** (up) and **`d`** (down) keys to set the failover order of models within a group.
*   **Per-Entry Cooldown**: Set custom recovery times for specific models.

### 🔑 Credential Management
*   **Sync from auth.json**: Instantly capture any accounts you've logged into via `/login`.
*   **Add Provider**: Guided setup for **🔑 API Key** or **🌐 OAuth / SSO** providers.
*   **Account Priority**: Use **`u`** and **`d`** keys to decide which account is `primary` and which are `backup-1`, `backup-2`, etc.
*   **Activate**: Manually "push" any stored HA credential into Pi's active `auth.json`.

### ⏱️ Settings
*   **Default Cooldown**: Set the default recovery time (e.g., 3600000ms for 1 hour) for exhausted providers.
*   **Default Group**: Choose which failover chain Pi uses when it starts up.

## 🔍 How Failover Works

### The Failover Chain
When a quota or capacity error is detected:
1.  **Try Next Account**: The extension looks for another credential for the *same* provider (e.g., your second Google account).
2.  **Mark Exhausted**: The current account is marked as exhausted and won't be used again until its cooldown expires.
3.  **Switch Provider**: If all accounts for that provider are exhausted, the extension looks at the **Active Group** and switches to the next provider/model in the list.
4.  **Automatic Retry**: Pi automatically resends your last message using the new provider and primary account, making the transition transparent.

### Error Detection
The extension detects:
*   **Quota Errors**: HTTP 429, "rate limit", "insufficient quota", etc.
*   **Capacity Errors**: "No capacity available", "Engine Overloaded", etc.
*   **Gemini Awareness**: Correctly waits for Google's internal retry attempts before triggering a failover.

## ⚙️ Configuration Guide (`ha.json`)

While you should use the `/ha` UI, you can also manually edit `~/.pi/agent/ha.json`:

```json
{
  "groups": {
    "pro": {
      "name": "Professional Tier",
      "entries": [
        { "id": "anthropic/claude-3-5-sonnet" },
        { "id": "google-gemini-cli/gemini-1.5-pro", "cooldownMs": 1800000 }
      ]
    }
  },
  "defaultGroup": "pro",
  "defaultCooldownMs": 3600000,
  "credentials": {
    "anthropic": {
      "primary": { "type": "oauth", "refresh": "...", "access": "..." },
      "backup-1": { "type": "api_key", "key": "..." }
    }
  }
}
```

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 🙏 Credits

Built for the [pi coding agent](https://github.com/mariozechner/pi) community.
