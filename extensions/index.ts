/**
 * High Availability Provider Extension for Pi
 * 
 * Automatically switches to fallback providers when quota is exhausted.
 * Supports multiple OAuth accounts for the same provider.
 */

import type {
  Model,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// =============================================================================
// Types
// =============================================================================

interface HaGroupEntry {
  /** Provider/model identifier. Can be "provider" or "provider/model-id" */
  id: string;
  /** Cooldown duration in milliseconds after quota hit (default: 1 hour) */
  cooldownMs?: number;
}

interface HaGroup {
  name: string;
  entries: HaGroupEntry[];
}

interface HaConfig {
  /** Provider groups for failover */
  groups: Record<string, HaGroup>;
  /** Default group to use on startup */
  defaultGroup?: string;
  /** Global default cooldown (default: 1 hour = 3600000ms) */
  defaultCooldownMs?: number;
}

/** Stored OAuth credentials for a backup account */
interface BackupOAuthEntry {
  /** Unique name for this backup (e.g., "gemini-backup-1") */
  name: string;
  /** The provider ID this backup is for (e.g., "google-gemini-cli") */
  providerId: string;
  /** The OAuth credentials */
  credentials: OAuthCredentials;
  /** When this backup was created */
  createdAt: string;
}

interface HaOAuthStorage {
  backups: BackupOAuthEntry[];
}

interface OAuthCredentials {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  projectId?: string;
  email?: string;
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
  /** Track which backup we're currently using per provider */
  activeBackup: Map<string, string>; // providerId -> backupName
}

// =============================================================================
// Configuration
// =============================================================================

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "ha.json");
const OAUTH_STORAGE_PATH = join(AGENT_DIR, "ha-oauth.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Quota error patterns to detect
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

// Capacity error patterns
const CAPACITY_ERROR_PATTERNS = [
  /capacity constraints/i,
  /engine overloaded/i,
  /no capacity available/i,
  /server overloaded/i,
  /temporarily unavailable/i,
];

// Google Gemini specific: only trigger on final "Retry failed" message
const GEMINI_FINAL_RETRY_PATTERN = /retry failed after \d+ attempts/i;

// =============================================================================
// State Management
// =============================================================================

const state: HaState = {
  activeGroup: null,
  exhausted: new Map(),
  lastRetryMessage: null,
  isRetrying: false,
  activeBackup: new Map(),
};

let config: HaConfig | null = null;

// =============================================================================
// Configuration Loaders
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

function loadOAuthStorage(): HaOAuthStorage {
  if (!existsSync(OAUTH_STORAGE_PATH)) {
    return { backups: [] };
  }

  try {
    const content = readFileSync(OAUTH_STORAGE_PATH, "utf-8");
    return JSON.parse(content) as HaOAuthStorage;
  } catch (err) {
    console.error("[HA] Failed to load ha-oauth.json:", err);
    return { backups: [] };
  }
}

function saveOAuthStorage(storage: HaOAuthStorage): void {
  try {
    writeFileSync(OAUTH_STORAGE_PATH, JSON.stringify(storage, null, 2), "utf-8");
  } catch (err) {
    console.error("[HA] Failed to save ha-oauth.json:", err);
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
// Utility Functions
// =============================================================================

function isQuotaError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(lowerMsg));
}

function isCapacityError(errorMessage: string | undefined, provider?: string): boolean {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();

  // Google Gemini specific: only trigger on "Retry failed after N attempts"
  if (provider?.includes("google") || provider?.includes("gemini")) {
    if (GEMINI_FINAL_RETRY_PATTERN.test(lowerMsg)) {
      console.log("[HA] Detected Gemini final retry failure");
      return true;
    }
    if (/no capacity available/.test(lowerMsg)) {
      console.log("[HA] Ignoring intermediate Gemini capacity error (waiting for final retry)");
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

function getCooldownMs(entry: HaGroupEntry, globalDefault: number): number {
  return entry.cooldownMs ?? globalDefault;
}

function parseEntryId(entryId: string): { provider: string; modelId?: string } {
  const parts = entryId.split("/");
  if (parts.length === 2) {
    return { provider: parts[0], modelId: parts[1] };
  }
  return { provider: entryId };
}

// =============================================================================
// OAuth Backup Management
// =============================================================================

/**
 * Save current OAuth credentials as a backup, then clear them for re-authentication
 */
async function prepareForBackupAuth(
  ctx: any,
  providerId: string,
  backupName: string
): Promise<boolean> {
  const auth = loadAuthJson();

  if (!auth[providerId] || auth[providerId].type !== "oauth") {
    ctx.ui.notify(`No OAuth credentials found for ${providerId}. Use /login first.`, "error");
    return false;
  }

  // Save current credentials as backup
  const storage = loadOAuthStorage();

  // Check if backup name already exists
  const existingIndex = storage.backups.findIndex(
    (b) => b.providerId === providerId && b.name === backupName
  );

  const backupEntry: BackupOAuthEntry = {
    name: backupName,
    providerId,
    credentials: auth[providerId],
    createdAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    storage.backups[existingIndex] = backupEntry;
    ctx.ui.notify(`Updated existing backup "${backupName}" for ${providerId}`, "info");
  } else {
    storage.backups.push(backupEntry);
    ctx.ui.notify(`Saved backup "${backupName}" for ${providerId}`, "info");
  }

  saveOAuthStorage(storage);

  // Remove from auth.json so user can re-authenticate
  delete auth[providerId];
  saveAuthJson(auth);

  ctx.ui.notify(
    `Cleared ${providerId} from auth.json.\nNow run /login to authenticate with your backup account.`,
    "info"
  );

  return true;
}

/**
 * Capture newly authenticated credentials as a backup
 */
async function captureBackupAuth(
  ctx: any,
  providerId: string,
  backupName: string
): Promise<boolean> {
  const auth = loadAuthJson();

  if (!auth[providerId] || auth[providerId].type !== "oauth") {
    ctx.ui.notify(
      `No OAuth credentials found for ${providerId}.\nMake sure you completed the /login flow.`,
      "error"
    );
    return false;
  }

  // Save as backup
  const storage = loadOAuthStorage();

  const existingIndex = storage.backups.findIndex(
    (b) => b.providerId === providerId && b.name === backupName
  );

  const backupEntry: BackupOAuthEntry = {
    name: backupName,
    providerId,
    credentials: auth[providerId],
    createdAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    storage.backups[existingIndex] = backupEntry;
  } else {
    storage.backups.push(backupEntry);
  }

  saveOAuthStorage(storage);

  ctx.ui.notify(`Captured backup "${backupName}" for ${providerId}`, "info");

  // Restore primary credentials if we have them
  const primaryBackup = storage.backups.find(
    (b) => b.providerId === providerId && b.name === "primary"
  );

  if (primaryBackup) {
    auth[providerId] = primaryBackup.credentials;
    saveAuthJson(auth);
    ctx.ui.notify(`Restored primary credentials for ${providerId}`, "info");
  } else {
    ctx.ui.notify(
      `No primary credentials found. You're now using the backup account as primary.`,
      "warning"
    );
  }

  return true;
}

/**
 * Switch to a backup OAuth account
 */
async function switchToBackup(
  ctx: any,
  providerId: string,
  backupName: string
): Promise<boolean> {
  const storage = loadOAuthStorage();
  const backup = storage.backups.find(
    (b) => b.providerId === providerId && b.name === backupName
  );

  if (!backup) {
    ctx.ui.notify(`Backup "${backupName}" not found for ${providerId}`, "error");
    return false;
  }

  // Save current as "primary" if we haven't already
  const auth = loadAuthJson();
  if (auth[providerId]?.type === "oauth") {
    const existingPrimary = storage.backups.find(
      (b) => b.providerId === providerId && b.name === "primary"
    );
    if (!existingPrimary) {
      storage.backups.push({
        name: "primary",
        providerId,
        credentials: auth[providerId],
        createdAt: new Date().toISOString(),
      });
      saveOAuthStorage(storage);
    }
  }

  // Switch to backup
  auth[providerId] = backup.credentials;
  saveAuthJson(auth);

  state.activeBackup.set(providerId, backupName);

  ctx.ui.notify(`Switched ${providerId} to backup account "${backupName}"`, "info");
  return true;
}

/**
 * List all backups for a provider
 */
function listBackups(providerId: string): BackupOAuthEntry[] {
  const storage = loadOAuthStorage();
  return storage.backups.filter((b) => b.providerId === providerId);
}

// =============================================================================
// Failover Logic
// =============================================================================

async function findNextAvailableProvider(
  pi: ExtensionAPI,
  ctx: any,
  currentModel: Model<any> | undefined
): Promise<{ model: Model<any>; entry: HaGroupEntry; useBackup?: string } | null> {
  if (!config || !state.activeGroup) return null;

  const group = config.groups[state.activeGroup];
  if (!group) return null;

  const globalDefaultCooldown = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;

  for (const entry of group.entries) {
    const { provider, modelId } = parseEntryId(entry.id);

    // Skip if this entry is currently exhausted
    if (isExhausted(entry.id)) {
      console.log(`[HA] Skipping exhausted entry: ${entry.id}`);
      continue;
    }

    // Check if we have a backup for this provider
    const backups = listBackups(provider);
    const activeBackup = state.activeBackup.get(provider);

    // Try to find an available model
    const availableModels = ctx.modelRegistry.getAvailable().filter(
      (m: Model<any>) => m.provider === provider
    );

    if (availableModels.length === 0) {
      console.log(`[HA] No models available for provider: ${provider}`);
      continue;
    }

    // Select the model
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

    // Check if we have auth for this model
    const apiKey = await ctx.modelRegistry.getApiKey(selectedModel);
    if (!apiKey) {
      console.log(`[HA] No API key available for ${selectedModel.provider}/${selectedModel.id}`);

      // Try to switch to a backup if available
      const unusedBackup = backups.find((b) => b.name !== activeBackup && b.name !== "primary");
      if (unusedBackup) {
        console.log(`[HA] Trying backup ${unusedBackup.name} for ${provider}`);
        const switched = await switchToBackup(ctx, provider, unusedBackup.name);
        if (switched) {
          // Retry getting API key
          const backupApiKey = await ctx.modelRegistry.getApiKey(selectedModel);
          if (backupApiKey) {
            return { model: selectedModel, entry, useBackup: unusedBackup.name };
          }
        }
      }
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

  if (!config) {
    console.log("[HA] No ha.json found. Run /ha-init to create one.");
  } else if (config.defaultGroup && config.groups[config.defaultGroup]) {
    state.activeGroup = config.defaultGroup;
    console.log(`[HA] Active group: ${state.activeGroup}`);
  }

  // =============================================================================
  // Commands
  // =============================================================================

  // Initialize HA configuration
  pi.registerCommand("ha-init", {
    description: "Initialize HA configuration file",
    handler: async (_args, ctx) => {
      if (existsSync(CONFIG_PATH)) {
        ctx.ui.notify("HA configuration already exists at ~/.pi/agent/ha.json", "warning");
        return;
      }

      const defaultConfig: HaConfig = {
        groups: {
          default: {
            name: "Default",
            entries: [
              { id: "anthropic/claude-3-5-sonnet" },
              { id: "google-gemini-cli/gemini-1.5-pro" },
            ],
          },
        },
        defaultGroup: "default",
        defaultCooldownMs: DEFAULT_COOLDOWN_MS,
      };

      saveConfig(defaultConfig);
      ctx.ui.notify("Created ~/.pi/agent/ha.json. Edit it to configure your failover groups.", "info");
    },
  });

  // Switch active group
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

  // Show HA status
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
          const activeBackup = state.activeBackup.get(provider);
          const backupInfo = activeBackup ? ` (backup: ${activeBackup})` : "";
          const status = exhausted ? "❌ exhausted" : "✅ available";
          lines.push(`  ${entry.id}${backupInfo} - ${status}`);
        }
      }

      // Show OAuth backups
      const storage = loadOAuthStorage();
      if (storage.backups.length > 0) {
        lines.push("");
        lines.push("OAuth backups:");
        const providers = new Set(storage.backups.map((b) => b.providerId));
        for (const providerId of providers) {
          const backups = storage.backups.filter((b) => b.providerId === providerId);
          lines.push(`  ${providerId}:`);
          for (const backup of backups) {
            const isActive = state.activeBackup.get(providerId) === backup.name;
            const marker = isActive ? "→ " : "  ";
            lines.push(`    ${marker}${backup.name} (${new Date(backup.createdAt).toLocaleDateString()})`);
          }
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

  // Create OAuth backup - Step 1: Save current and clear
  pi.registerCommand("ha-backup-create", {
    description: "Create a backup OAuth account (Step 1: Save current credentials)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(" ");
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /ha-backup-create <provider-id> <backup-name>", "error");
        ctx.ui.notify("Example: /ha-backup-create google-gemini-cli backup-1", "info");
        return;
      }

      const [providerId, backupName] = parts;

      if (backupName === "primary") {
        ctx.ui.notify("'primary' is a reserved backup name. Use a different name.", "error");
        return;
      }

      const success = await prepareForBackupAuth(ctx, providerId, backupName);
      if (success) {
        ctx.ui.notify(
          `\nNext steps:\n` +
          `1. Run /login to authenticate with your backup account\n` +
          `2. Run: /ha-backup-capture ${providerId} ${backupName}`,
          "info"
        );
      }
    },
  });

  // Create OAuth backup - Step 2: Capture new credentials
  pi.registerCommand("ha-backup-capture", {
    description: "Create a backup OAuth account (Step 2: Capture new credentials)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(" ");
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /ha-backup-capture <provider-id> <backup-name>", "error");
        return;
      }

      const [providerId, backupName] = parts;
      await captureBackupAuth(ctx, providerId, backupName);
    },
  });

  // Switch to a backup OAuth account
  pi.registerCommand("ha-backup-switch", {
    description: "Switch to a backup OAuth account",
    handler: async (args, ctx) => {
      const parts = args.trim().split(" ");
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /ha-backup-switch <provider-id> <backup-name>", "error");
        ctx.ui.notify("Example: /ha-backup-switch google-gemini-cli backup-1", "info");
        return;
      }

      const [providerId, backupName] = parts;
      await switchToBackup(ctx, providerId, backupName);
    },
  });

  // List OAuth backups for a provider
  pi.registerCommand("ha-backup-list", {
    description: "List OAuth backups for a provider",
    handler: async (args, ctx) => {
      const providerId = args.trim();
      if (!providerId) {
        ctx.ui.notify("Usage: /ha-backup-list <provider-id>", "error");
        return;
      }

      const backups = listBackups(providerId);
      if (backups.length === 0) {
        ctx.ui.notify(`No backups found for ${providerId}`, "info");
        return;
      }

      const lines: string[] = [];
      lines.push(`Backups for ${providerId}:`);
      for (const backup of backups) {
        const isActive = state.activeBackup.get(providerId) === backup.name;
        const marker = isActive ? "→ " : "  ";
        lines.push(`${marker}${backup.name} (${new Date(backup.createdAt).toLocaleDateString()})`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
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

    // Mark current provider as exhausted
    if (currentModel) {
      const currentEntryId = `${currentModel.provider}/${currentModel.id}`;
      const globalDefaultCooldown = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
      markExhausted(currentEntryId, globalDefaultCooldown);
      console.log(`[HA] Marked ${currentEntryId} as exhausted`);
    }

    // Try to switch to a backup first if available
    if (currentProvider) {
      const backups = listBackups(currentProvider);
      const activeBackup = state.activeBackup.get(currentProvider);
      const unusedBackup = backups.find(
        (b) => b.name !== activeBackup && b.name !== "primary"
      );

      if (unusedBackup) {
        console.log(`[HA] Trying backup ${unusedBackup.name} for ${currentProvider}`);
        const switched = await switchToBackup(ctx, currentProvider, unusedBackup.name);
        if (switched) {
          ctx.ui.notify(
            `⚠️ ${isCapacityError(message.errorMessage, currentProvider) ? "Capacity" : "Quota"} hit on ${currentProvider}!\n` +
            `Switched to backup account "${unusedBackup.name}". Retrying...`,
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
            state.lastRetryMessage =
              typeof lastUserMessage.message.content === "string"
                ? lastUserMessage.message.content
                : JSON.stringify(lastUserMessage.message.content);

            await new Promise((resolve) => setTimeout(resolve, 500));
            pi.sendUserMessage(lastUserMessage.message.content, { deliverAs: "steer" });

            setTimeout(() => {
              state.isRetrying = false;
            }, 5000);
          }
          return;
        }
      }
    }

    // Find next available provider in group
    const next = await findNextAvailableProvider(pi, ctx, currentModel);
    if (!next) {
      ctx.ui.notify("⚠️ All providers in group exhausted. No failover available.", "error");
      return;
    }

    // Notify user
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

    // Switch model
    const success = await pi.setModel(next.model);
    if (!success) {
      ctx.ui.notify(`Failed to switch to ${toProvider}. Check authentication.`, "error");
      return;
    }

    console.log(`[HA] Switched to ${toProvider}`);

    // Get the last user message for retry
    const branch = ctx.sessionManager.getBranch();
    const lastUserMessage = branch
      .slice()
      .reverse()
      .find((entry: any) => entry.type === "message" && entry.message?.role === "user");

    if (!lastUserMessage) {
      console.log("[HA] No user message found to retry");
      return;
    }

    // Prevent duplicate retries
    const messageContent =
      typeof lastUserMessage.message.content === "string"
        ? lastUserMessage.message.content
        : JSON.stringify(lastUserMessage.message.content);

    if (state.lastRetryMessage === messageContent) {
      console.log("[HA] Already retried this message, skipping");
      return;
    }

    // Mark as retrying and store message
    state.isRetrying = true;
    state.lastRetryMessage = messageContent;

    // Wait a moment for the model switch to settle
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Resend the message
    try {
      console.log("[HA] Retrying last message...");
      pi.sendUserMessage(lastUserMessage.message.content, { deliverAs: "steer" });
      ctx.ui.notify("Retrying with new provider...", "info");
    } catch (err) {
      console.error("[HA] Failed to retry message:", err);
      ctx.ui.notify("Failed to retry message. Please try manually.", "error");
    } finally {
      // Reset retry flag after a delay
      setTimeout(() => {
        state.isRetrying = false;
      }, 5000);
    }
  });

  // Reset retry flag on successful message (non-error turn)
  pi.on("turn_start", async (_event, _ctx) => {
    if (state.lastRetryMessage && !state.isRetrying) {
      state.lastRetryMessage = null;
    }
  });

  console.log("[HA] High Availability extension loaded");
}
