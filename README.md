# pi-high-availability 🔄

**pi-high-availability** automatically switches to fallback LLM providers when your primary provider hits quota limits or capacity constraints. Never get stuck waiting for quota resets again.

## ✨ Features

- **Password-Store Integration**: Use `!pass` references for API keys stored in [password-store](https://www.passwordstore.org/). The `/ha` UI discovers matching entries automatically.
- **Per-Session Group Selection**: Use `--ha-group` flag to select different failover chains per session.
- **Unified HA Manager**: A beautiful interactive TUI (`/ha`) with accordion-style navigation to manage all your groups and credentials in one place.
- **Automatic Multi-Tier Failover**: 
    1. **Account Failover**: Seamlessly switches between multiple accounts for the *same* provider.
    2. **Provider Failover**: Automatically jumps to the next provider in your group if all accounts for the current provider are exhausted.
- **Exhaustion Tracking**: Intelligent cooldown management marks specific accounts or providers as "exhausted" on 429/capacity errors, preventing retries until they recover.
- **Dynamic Provider Discovery**: Automatically detects all supported Pi providers (Anthropic, OpenAI, Gemini, Moonshot, Zai, etc.) without configuration.
- **Group Management**: Create custom failover chains (e.g., "Fast Tier" → "Backup Tier") and rearrange model priority with simple keybindings.
- **Credential Sync & Storage**: Automatically capture OAuth logins or manually add API keys for backup accounts.
- **Smart Error Detection**: Distinguishes between network, quota, and capacity errors with configurable handling for each type.

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

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate items |
| `Space` / `→` | Expand/collapse section or toggle item |
| `Enter` | Select/activate item |
| `x` / `d` / `Delete` | Delete currently selected item (with confirmation) |
| `u` | Move item up (reorder) |
| `d` | Move item down (reorder) |
| `Esc` | Cancel / Exit |

### 📂 Group Management
*   **Add/Rename/Delete** groups.
*   **Rearrange Priority**: Use **`u`** (up) and **`d`** (down) keys to set the failover order of models within a group.
*   **Per-Entry Cooldown**: Set custom recovery times for specific models.
*   **Delete Models**: Navigate to any model entry and press **`x`** to remove it from the group.

### 🔑 Credential Management
*   **Auto-Sync**: Credentials from `/login` are automatically synced when you open `/ha`.
*   **Password-Store**: Matching pass entries appear as one-click options for API providers.
*   **Add API Providers**: Use **"+ Add API Provider"** to manually add providers that use API keys.
*   **Add API Keys**: For non-OAuth providers, add additional API keys as backups (or use `!pass show path/to/key`).
*   **Account Priority**: Use **`u`** and **`d`** keys to decide which account is `primary` and which are `backup-1`, `backup-2`, etc.
*   **Delete Keys**: Navigate to any key entry and press **`x`** to delete it.
*   **Delete Providers**: Navigate to a provider header (e.g., `🔌 google-gemini-cli`) and press **`x`** to delete the entire provider and all its keys.

### ⏱️ Settings
*   **Default Cooldown**: Set the default recovery time (e.g., 3600000ms for 1 hour) for exhausted providers.
*   **Default Group**: Choose which failover chain Pi uses when it starts up.
*   **Error Handling**: Configure how different error types are handled:
    *   **Network Error Action**: Transient network issues (default: `retry` after 1 second)
    *   **Capacity Error Action**: Provider has no capacity (default: `next_key_then_provider`)
    *   **Quota Error Action**: Account hit rate limit (default: `next_key_then_provider`)
    *   **Retry Timeout**: How long to wait before retrying capacity/quota errors (default: 300000ms = 5 minutes)

## 🔍 How Failover Works

### The Failover Chain
When a quota or capacity error is detected:
1.  **Try Next Account**: The extension looks for another credential for the *same* provider (e.g., your second Google account).
2.  **Mark Exhausted**: The current account is marked as exhausted and won't be used again until its cooldown expires (not done for network errors, which are transient).
3.  **Switch Provider**: If all accounts for that provider are exhausted, the extension looks at the **Active Group** and switches to the next provider/model in the list.
4.  **Automatic Retry**: Pi automatically resends your last message using the new provider and primary account, making the transition transparent.

### Error Detection
The extension detects:
*   **Network Errors**: Connection resets, timeouts, internal network failures — transient issues resolved by retry
*   **Quota Errors**: HTTP 429, "rate limit", "insufficient quota" — per-account limits
*   **Capacity Errors**: "No capacity available", "Engine Overloaded" — provider-level issues

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
  "errorHandling": {
    "capacityErrorAction": "next_provider",
    "quotaErrorAction": "next_key_then_provider",
    "networkErrorAction": "retry",
    "retryTimeoutMs": 300000,
    "networkRetryDelayMs": 1000
  },
  "credentials": {
    "anthropic": {
      "primary": { "type": "oauth", "refresh": "...", "access": "..." },
      "backup-1": { "type": "api_key", "key": "!pass show api/anthropic/key" }
    }
  }
}
```

### Error Handling Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `capacityErrorAction` | Action when provider has no capacity (affects all accounts) | `next_key_then_provider` |
| `quotaErrorAction` | Action when account hits rate limit (may not affect other accounts) | `next_key_then_provider` |
| `networkErrorAction` | Action when transient network error occurs | `retry` |
| `retryTimeoutMs` | How long to wait before retrying capacity/quota errors (ms) | `300000` (5 minutes) |
| `networkRetryDelayMs` | How long to wait before retrying network errors (ms) | `1000` (1 second) |

#### Available Actions

| Action | Description |
|--------|-------------|
| `stop` | Stop the process and display the error |
| `retry` | Wait for configured timeout, then retry the same request |
| `next_provider` | Immediately switch to the next provider in the current group |
| `next_key_then_provider` | Try the next account/key for the current provider, then move to next provider if all exhausted |

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## 🙏 Credits

Built for the [pi coding agent](https://github.com/mariozechner/pi) community.