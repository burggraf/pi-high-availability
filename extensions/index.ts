/**
 * High Availability Provider Extension for Pi
 *
 * Automatically switches to fallback providers when quota is exhausted.
 * Supports multiple credentials (OAuth and API keys) per provider.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// =============================================================================
// Types
// =============================================================================

interface HaGroupEntry {
  id: string;
  cooldownMs?: number;
}

interface HaGroup {
  name: string;
  entries: HaGroupEntry[];
}

interface HaConfig {
  groups: Record<string, HaGroup>;
  defaultGroup?: string;
  defaultCooldownMs?: number;
  /**
   * Credential storage - keyed by provider ID, contains multiple named credentials
   * e.g., "google-gemini-cli": { "primary": {...}, "backup-1": {...} }
   * Supports both OAuth and API key types
   */
  credentials?: Record<string, Record<string, any>>;
}

interface ExhaustedEntry {
  id: string;
  exhaustedAt: number;
  cooldownMs: number;
}

interface HaState {
  activeGroup: string | null;
  exhausted: Map<string, ExhaustedEntry>;
  lastRetryMessage: string | null;
  isRetrying: boolean;
  /**
   * Track which OAuth credential is active for each provider
   * e.g., "google-gemini-cli" -> "primary"
   */
  activeCredential: Map<string, string>;
}

// =============================================================================
// Configuration
// =============================================================================

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "ha.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

const QUOTA_ERROR_PATTERNS = [
  /429/i,
  /quota exceeded/i,
  /resource exhausted/i,
  /rate limit/i,
  /rate_limit/i,
  /exceeded_current_quota/i,
  /insufficient quota/i,
  /billing.*exhausted/i,
];

const CAPACITY_ERROR_PATTERNS = [
  /capacity constraints/i,
  /engine overloaded/i,
  /no capacity available/i,
  /server overloaded/i,
  /temporarily unavailable/i,
];

const GEMINI_FINAL_RETRY_PATTERN = /retry failed after \d+ attempts/i;

// =============================================================================
// State Management
// =============================================================================

const state: HaState = {
  activeGroup: null,
  exhausted: new Map(),
  lastRetryMessage: null,
  isRetrying: false,
  activeCredential: new Map(),
};

let config: HaConfig | null = null;

// =============================================================================
// Configuration Functions
// =============================================================================

function loadConfig(): HaConfig | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(content) as HaConfig;
  } catch (err) {
    console.error("[HA] Failed to load ha.json:", err);
    return null;
  }
}

function saveConfig(cfg: HaConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("[HA] Failed to save ha.json:", err);
  }
}

function loadAuthJson(): Record<string, any> {
  if (!existsSync(AUTH_PATH)) {
    return {};
  }
  try {
    const content = readFileSync(AUTH_PATH, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.error("[HA] Failed to load auth.json:", err);
    return {};
  }
}

function saveAuthJson(auth: Record<string, any>): void {
  try {
    writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), "utf-8");
  } catch (err) {
    console.error("[HA] Failed to save auth.json:", err);
  }
}

// =============================================================================
// OAuth Sync Functions
// =============================================================================

/**
 * Sync all credentials from auth.json to ha.json
 * Preserves existing entries, adds new ones with unique names
 * Handles both OAuth and API key entries
 */
function syncAuthToHa(): void {
  if (!config) return;

  const auth = loadAuthJson();
  if (!config.credentials) {
    config.credentials = {};
  }

  let changed = false;

  for (const [providerId, credentials] of Object.entries(auth)) {
    // Initialize provider entry if needed
    if (!config.credentials[providerId]) {
      config.credentials[providerId] = {};
    }

    const existingEntries = config.credentials[providerId];
    
    // Check if this exact credential already exists
    let found = false;
    for (const [name, existingCreds] of Object.entries(existingEntries)) {
      if (credentialsMatch(credentials, existingCreds)) {
        found = true;
        break;
      }
    }

    if (!found) {
      // Find a unique name
      let name = "primary";
      if (existingEntries["primary"]) {
        let counter = 1;
        while (existingEntries[`backup-${counter}`]) {
          counter++;
        }
        name = `backup-${counter}`;
      }
      
      existingEntries[name] = credentials;
      changed = true;
      console.log(`[HA] Synced ${credentials.type} for ${providerId} as "${name}"`);
    }
  }

  if (changed) {
    saveConfig(config);
  }
}

/**
 * Check if two credential objects match (by refresh token or key fields)
 */
function credentialsMatch(a: any, b: any): boolean {
  if (a.type !== b.type) return false;
  
  if (a.type === "oauth") {
    // Compare by refresh token (most reliable identifier)
    return a.refresh === b.refresh;
  }
  
  if (a.type === "api_key") {
    return a.key === b.key;
  }
  
  return false;
}

/**
 * Switch to a specific OAuth credential for a provider
 */
function switchOAuthCredential(providerId: string, credentialName: string): boolean {
  if (!config?.credentials?.[providerId]?.[credentialName]) {
    return false;
  }

  const auth = loadAuthJson();
  auth[providerId] = config.credentials[providerId][credentialName];
  saveAuthJson(auth);
  
  state.activeCredential.set(providerId, credentialName);
  return true;
}

/**
 * Get next available credential for a provider that isn't exhausted
 */
function getNextCredential(providerId: string): string | null {
  if (!config?.credentials?.[providerId]) return null;

  const entries = config.credentials[providerId];
  const current = state.activeCredential.get(providerId) || "primary";
  
  const names = Object.keys(entries);
  if (names.length <= 1) return null;

  const currentIndex = names.indexOf(current);
  const startIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % names.length;

  // Look for the first non-exhausted credential starting from the next one
  for (let i = 0; i < names.length; i++) {
    const index = (startIndex + i) % names.length;
    const name = names[index];
    
    // Don't return the one we're already on
    if (name === current) continue;
    
    // Check if this specific credential is exhausted
    if (!isExhausted(`${providerId}:${name}`)) {
      return name;
    }
  }

  return null;
}

function isQuotaError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(lowerMsg));
}

function isCapacityError(errorMessage: string | undefined, provider?: string): boolean {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();

  if (provider?.includes("google") || provider?.includes("gemini")) {
    if (GEMINI_FINAL_RETRY_PATTERN.test(lowerMsg)) {
      console.log("[HA] Detected Gemini final retry failure");
      return true;
    }
    if (/no capacity available/.test(lowerMsg)) {
      console.log("[HA] Ignoring intermediate Gemini capacity error");
      return false;
    }
  }

  return CAPACITY_ERROR_PATTERNS.some((pattern) => pattern.test(lowerMsg));
}

function shouldTriggerFailover(errorMessage: string | undefined, provider?: string): boolean {
  return isQuotaError(errorMessage) || isCapacityError(errorMessage, provider);
}

function isExhausted(entryId: string): boolean {
  const entry = state.exhausted.get(entryId);
  if (!entry) return false;

  const now = Date.now();
  if (now - entry.exhaustedAt >= entry.cooldownMs) {
    state.exhausted.delete(entryId);
    return false;
  }

  return true;
}

function markExhausted(entryId: string, cooldownMs: number): void {
  state.exhausted.set(entryId, {
    id: entryId,
    exhaustedAt: Date.now(),
    cooldownMs,
  });
}

function parseEntryId(entryId: string): { provider: string; modelId?: string } {
  const parts = entryId.split("/");
  if (parts.length === 2) {
    return { provider: parts[0], modelId: parts[1] };
  }
  return { provider: entryId };
}

async function findNextAvailableProvider(
  pi: ExtensionAPI,
  ctx: any,
  currentModel: Model<any> | undefined
): Promise<{ model: Model<any>; entry: HaGroupEntry } | null> {
  if (!config || !state.activeGroup) return null;

  const group = config.groups[state.activeGroup];
  if (!group) return null;

  const globalDefaultCooldown = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;

  for (const entry of group.entries) {
    const { provider, modelId } = parseEntryId(entry.id);

    if (isExhausted(entry.id)) {
      console.log(`[HA] Skipping exhausted entry: ${entry.id}`);
      continue;
    }

    const availableModels = ctx.modelRegistry.getAvailable().filter(
      (m: Model<any>) => m.provider === provider
    );

    if (availableModels.length === 0) {
      console.log(`[HA] No models available for provider: ${provider}`);
      continue;
    }

    let selectedModel: Model<any>;
    if (modelId) {
      selectedModel = availableModels.find((m: Model<any>) => m.id === modelId);
      if (!selectedModel) {
        console.log(`[HA] Model ${modelId} not found in provider ${provider}`);
        continue;
      }
    } else {
      selectedModel = availableModels[0];
    }

    const apiKey = await ctx.modelRegistry.getApiKey(selectedModel);
    if (!apiKey) {
      console.log(`[HA] No API key available for ${selectedModel.provider}/${selectedModel.id}`);
      continue;
    }

    return { model: selectedModel, entry };
  }

  return null;
}

// =============================================================================
// Main Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  config = loadConfig();

  if (config) {
    if (config.defaultGroup && config.groups[config.defaultGroup]) {
      state.activeGroup = config.defaultGroup;
      console.log(`[HA] Active group: ${state.activeGroup}`);
    }
    // Sync OAuth on startup
    syncAuthToHa();
  } else {
    console.log("[HA] No ha.json found. Run /ha-init to create one.");
  }

  // =============================================================================
  // Commands
  // =============================================================================

  pi.registerCommand("ha-init", {
    description: "Initialize HA configuration file",
    handler: async (_args, ctx) => {
      if (existsSync(CONFIG_PATH)) {
        ctx.ui.notify("HA configuration already exists at ~/.pi/agent/ha.json", "warning");
        return;
      }

      // Build entries from actual providers in auth.json
      const auth = loadAuthJson();
      const entries: HaGroupEntry[] = [];
      
      for (const providerId of Object.keys(auth)) {
        entries.push({ id: providerId });
      }

      // If no providers, add some defaults
      if (entries.length === 0) {
        entries.push(
          { id: "anthropic" },
          { id: "google-gemini-cli" },
          { id: "openai" }
        );
      }

      const defaultConfig: HaConfig = {
        groups: {
          default: {
            name: "Default",
            entries,
          },
        },
        defaultGroup: "default",
        defaultCooldownMs: DEFAULT_COOLDOWN_MS,
        credentials: {},
      };

      saveConfig(defaultConfig);
      
      // Reload config so it's immediately available
      config = loadConfig();
      if (config?.defaultGroup) {
        state.activeGroup = config.defaultGroup;
      }
      
      ctx.ui.notify(`Created ~/.pi/agent/ha.json with ${entries.length} provider(s). Run /ha-sync to sync credentials.`, "info");
    },
  });

  pi.registerCommand("ha-use", {
    description: "Switch to a failover group",
    handler: async (args, ctx) => {
      const groupName = args.trim();
      if (!groupName) {
        ctx.ui.notify("Usage: /ha-use <group-name>", "error");
        return;
      }

      if (!config || !config.groups[groupName]) {
        ctx.ui.notify(`Group '${groupName}' not found in ha.json`, "error");
        return;
      }

      state.activeGroup = groupName;
      state.exhausted.clear();
      ctx.ui.notify(`Switched to HA group: ${groupName}`, "info");
    },
  });

  pi.registerCommand("ha-status", {
    description: "Show HA status and exhausted providers",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify("HA not configured. Run /ha-init first.", "warning");
        return;
      }

      const lines: string[] = [];
      lines.push(`Active group: ${state.activeGroup ?? "none"}`);
      lines.push("");

      if (state.activeGroup && config.groups[state.activeGroup]) {
        const group = config.groups[state.activeGroup];
        lines.push(`Group '${state.activeGroup}' entries:`);
        for (const entry of group.entries) {
          const exhausted = isExhausted(entry.id);
          const { provider } = parseEntryId(entry.id);
          const activeCredential = state.activeCredential.get(provider);
          const oauthInfo = activeCredential ? ` [${activeCredential}]` : "";
          const status = exhausted ? "❌ exhausted" : "✅ available";
          lines.push(`  ${entry.id}${oauthInfo} - ${status}`);
        }
      }

      // Show OAuth credentials
      if (config.credentials && Object.keys(config.credentials).length > 0) {
        lines.push("");
        lines.push("Credentials stored:");
        for (const [providerId, entries] of Object.entries(config.credentials)) {
          const names = Object.keys(entries);
          const active = state.activeCredential.get(providerId) || "primary";
          lines.push(`  ${providerId}: ${names.join(", ")} (active: ${active})`);
        }
      }

      if (state.exhausted.size > 0) {
        lines.push("");
        lines.push("Exhausted providers (cooldown active):");
        const now = Date.now();
        for (const [id, entry] of state.exhausted) {
          const remaining = Math.ceil((entry.cooldownMs - (now - entry.exhaustedAt)) / 1000 / 60);
          lines.push(`  ${id} - ${remaining}m remaining`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ha-sync", {
    description: "Sync all credentials from auth.json to ha.json",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify("HA not configured. Run /ha-init first.", "warning");
        return;
      }

      syncAuthToHa();
      ctx.ui.notify("Synced credentials from auth.json to ha.json", "info");
    },
  });

  pi.registerCommand("ha-switch", {
    description: "Switch to a different credential for a provider",
    handler: async (args, ctx) => {
      const parts = args.trim().split(" ");
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /ha-switch <provider> <credential-name>", "error");
        ctx.ui.notify("Example: /ha-switch google-gemini-cli backup-1", "info");
        return;
      }

      const [providerId, credentialName] = parts;

      const success = switchOAuthCredential(providerId, credentialName);
      if (success) {
        ctx.ui.notify(`Switched ${providerId} to "${credentialName}"`, "info");
      } else {
        ctx.ui.notify(`Failed to switch. Credential "${credentialName}" not found for ${providerId}.`, "error");
      }
    },
  });

  // =============================================================================
  // Failover Hook
  // =============================================================================

  pi.on("turn_end", async (event, ctx) => {
    if (!config || !state.activeGroup) return;
    if (state.isRetrying) return;

    const message = event.message;
    if (!message || message.role !== "assistant") return;

    const hasError = message.stopReason === "error" || message.errorMessage;
    if (!hasError) return;

    const currentModel = ctx.model;
    const currentProvider = currentModel?.provider;

    if (!shouldTriggerFailover(message.errorMessage, currentProvider)) {
      console.log(`[HA] Error detected but not failover-worthy: ${message.errorMessage}`);
      return;
    }

    console.log(`[HA] Failover error detected: ${message.errorMessage}`);

    // Try switching to next credential for the current provider first
    if (currentProvider) {
      const currentCredName = state.activeCredential.get(currentProvider) || "primary";
      const globalDefaultCooldown = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
      
      // Mark the current credential as exhausted
      markExhausted(`${currentProvider}:${currentCredName}`, globalDefaultCooldown);

      const nextCredential = getNextCredential(currentProvider);
      if (nextCredential) {
        console.log(`[HA] Trying next credential "${nextCredential}" for ${currentProvider}`);
        const switched = switchOAuthCredential(currentProvider, nextCredential);
        if (switched) {
          ctx.ui.notify(
            `⚠️ ${isCapacityError(message.errorMessage, currentProvider) ? "Capacity" : "Quota"} hit!\n` +
            `Switched ${currentProvider} to account "${nextCredential}". Retrying...`,
            "warning"
          );

          // Retry the message
          const branch = ctx.sessionManager.getBranch();
          const lastUserMessage = branch
            .slice()
            .reverse()
            .find((entry: any) => entry.type === "message" && entry.message?.role === "user");

          if (lastUserMessage) {
            state.isRetrying = true;
            state.lastRetryMessage = typeof lastUserMessage.message.content === "string"
              ? lastUserMessage.message.content
              : JSON.stringify(lastUserMessage.message.content);

            await new Promise((resolve) => setTimeout(resolve, 500));
            pi.sendUserMessage(lastUserMessage.message.content, { deliverAs: "steer" });

            setTimeout(() => { state.isRetrying = false; }, 5000);
          }
          return;
        }
      }
    }

    // Mark current provider as exhausted
    if (currentModel) {
      const currentEntryId = `${currentModel.provider}/${currentModel.id}`;
      const globalDefaultCooldown = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
      markExhausted(currentEntryId, globalDefaultCooldown);
      console.log(`[HA] Marked ${currentEntryId} as exhausted`);
    }

    // Find next available provider in group
    const next = await findNextAvailableProvider(pi, ctx, currentModel);
    if (!next) {
      ctx.ui.notify("⚠️ All providers in group exhausted. No failover available.", "error");
      return;
    }

    // Notify and switch
    const fromProvider = currentModel
      ? `${currentModel.provider}/${currentModel.id}`
      : "current";
    const toProvider = `${next.model.provider}/${next.model.id}`;
    const errorType = isCapacityError(message.errorMessage, currentProvider)
      ? "Capacity exhausted"
      : "Quota hit";

    ctx.ui.notify(
      `⚠️ ${errorType} on ${fromProvider}!\nSwitching to ${toProvider}...`,
      "warning"
    );

    const success = await pi.setModel(next.model);
    if (!success) {
      ctx.ui.notify(`Failed to switch to ${toProvider}. Check authentication.`, "error");
      return;
    }

    console.log(`[HA] Switched to ${toProvider}`);

    // Retry the message
    const branch = ctx.sessionManager.getBranch();
    const lastUserMessage = branch
      .slice()
      .reverse()
      .find((entry: any) => entry.type === "message" && entry.message?.role === "user");

    if (!lastUserMessage) {
      console.log("[HA] No user message found to retry");
      return;
    }

    const messageContent = typeof lastUserMessage.message.content === "string"
      ? lastUserMessage.message.content
      : JSON.stringify(lastUserMessage.message.content);

    if (state.lastRetryMessage === messageContent) {
      console.log("[HA] Already retried this message, skipping");
      return;
    }

    state.isRetrying = true;
    state.lastRetryMessage = messageContent;

    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      console.log("[HA] Retrying last message...");
      pi.sendUserMessage(lastUserMessage.message.content, { deliverAs: "steer" });
      ctx.ui.notify("Retrying with new provider...", "info");
    } catch (err) {
      console.error("[HA] Failed to retry message:", err);
      ctx.ui.notify("Failed to retry message. Please try manually.", "error");
    } finally {
      setTimeout(() => { state.isRetrying = false; }, 5000);
    }
  });

  // Reset retry flag on successful turn
  pi.on("turn_start", async (_event, _ctx) => {
    if (state.lastRetryMessage && !state.isRetrying) {
      state.lastRetryMessage = null;
    }
  });

  console.log("[HA] High Availability extension loaded");
}
