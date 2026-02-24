/**
 * High Availability Provider Extension for Pi
 * 
 * Automatically switches to fallback providers when quota is exhausted.
 * Supports both API key and OAuth providers, with custom provider registration
 * for multiple OAuth accounts per provider.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync } from "fs";
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
  /** Custom OAuth provider definitions for backup accounts */
  customProviders?: CustomProviderDefinition[];
}

interface CustomProviderDefinition {
  /** Unique ID for this custom provider (e.g., "ha-gemini-backup-1") */
  id: string;
  /** Display name for login UI */
  name: string;
  /** Base provider to mirror models from (e.g., "google-gemini-cli") */
  mirrors: string;
  /** API type */
  api: string;
  /** Base URL for API endpoint */
  baseUrl: string;
  /** OAuth configuration */
  oauth: {
    /** Authorization URL */
    authorizeUrl: string;
    /** Token URL */
    tokenUrl: string;
    /** Client ID (can be base64 encoded) */
    clientId: string;
    /** Redirect URI */
    redirectUri: string;
    /** OAuth scopes */
    scopes: string;
    /** Whether clientId is base64 encoded */
    clientIdEncoded?: boolean;
  };
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
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG_PATH = join(homedir(), ".pi", "ha.json");
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Quota error patterns to detect
// Quota error patterns - trigger immediately
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

// Capacity error patterns - trigger immediately for most providers
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
};

let config: HaConfig | null = null;

// =============================================================================
// Configuration Loader
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

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if error is a quota/rate limit error (trigger immediately)
 */
function isQuotaError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(lowerMsg));
}

/**
 * Check if error is a capacity error.
 * For Google Gemini: only trigger on final "Retry failed" message.
 * For other providers: trigger on immediate capacity errors.
 */
function isCapacityError(errorMessage: string | undefined, provider?: string): boolean {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();

  // Google Gemini specific: only trigger on "Retry failed after N attempts"
  // This indicates the internal retries have exhausted
  if (provider?.includes("google") || provider?.includes("gemini")) {
    // Check if it's the final retry failure
    if (GEMINI_FINAL_RETRY_PATTERN.test(lowerMsg)) {
      console.log("[HA] Detected Gemini final retry failure");
      return true;
    }
    // Don't trigger on intermediate "No capacity" messages
    if (/no capacity available/.test(lowerMsg)) {
      console.log("[HA] Ignoring intermediate Gemini capacity error (waiting for final retry)");
      return false;
    }
  }

  // For other providers, trigger on immediate capacity errors
  return CAPACITY_ERROR_PATTERNS.some((pattern) => pattern.test(lowerMsg));
}

/**
 * Check if error should trigger failover
 */
function shouldTriggerFailover(errorMessage: string | undefined, provider?: string): boolean {
  return isQuotaError(errorMessage) || isCapacityError(errorMessage, provider);
}

function isExhausted(entryId: string): boolean {
  const entry = state.exhausted.get(entryId);
  if (!entry) return false;
  
  const now = Date.now();
  if (now - entry.exhaustedAt >= entry.cooldownMs) {
    // Cooldown expired, remove from exhausted list
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
// PKCE Utilities for OAuth
// =============================================================================

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { verifier, challenge };
}

// =============================================================================
// Custom Provider Registration
// =============================================================================

function registerCustomProviders(pi: ExtensionAPI, cfg: HaConfig): void {
  if (!cfg.customProviders) return;

  const availableModels = pi.getAvailableModels?.() || [];

  for (const customProvider of cfg.customProviders) {
    // Find models to mirror from the base provider
    const modelsToMirror = availableModels.filter(
      (m) => m.provider === customProvider.mirrors
    );

    if (modelsToMirror.length === 0) {
      console.warn(
        `[HA] No models found to mirror from ${customProvider.mirrors} for ${customProvider.id}`
      );
      continue;
    }

    // Mirror models with new provider name
    const mirroredModels = modelsToMirror.map((model) => ({
      id: model.id,
      name: `${model.name} (${customProvider.name})`,
      api: customProvider.api as Api,
      reasoning: model.reasoning ?? false,
      input: model.input ?? (["text"] as ("text" | "image")[]),
      cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 4096,
    }));

    // Decode client ID if needed
    const clientId = customProvider.oauth.clientIdEncoded
      ? atob(customProvider.oauth.clientId)
      : customProvider.oauth.clientId;

    // Register the custom provider with OAuth
    pi.registerProvider(customProvider.id, {
      baseUrl: customProvider.baseUrl,
      api: customProvider.api as Api,
      models: mirroredModels,
      oauth: {
        name: customProvider.name,
        login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
          const { verifier, challenge } = await generatePKCE();

          const authParams = new URLSearchParams({
            code: "true",
            client_id: clientId,
            response_type: "code",
            redirect_uri: customProvider.oauth.redirectUri,
            scope: customProvider.oauth.scopes,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: verifier,
          });

          callbacks.onAuth({
            url: `${customProvider.oauth.authorizeUrl}?${authParams.toString()}`,
          });

          const authCode = await callbacks.onPrompt({
            message: "Paste the authorization code:",
          });
          const [code, stateValue] = authCode.split("#");

          const tokenResponse = await fetch(customProvider.oauth.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              state: stateValue,
              redirect_uri: customProvider.oauth.redirectUri,
              code_verifier: verifier,
            }),
          });

          if (!tokenResponse.ok) {
            throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
          }

          const data = (await tokenResponse.json()) as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
          };

          return {
            refresh: data.refresh_token,
            access: data.access_token,
            expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
          };
        },
        refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => {
          const response = await fetch(customProvider.oauth.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token: credentials.refresh,
            }),
          });

          if (!response.ok) {
            throw new Error(`Token refresh failed: ${await response.text()}`);
          }

          const data = (await response.json()) as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
          };

          return {
            refresh: data.refresh_token,
            access: data.access_token,
            expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
          };
        },
        getApiKey: (cred: OAuthCredentials) => cred.access,
      },
    });

    console.log(
      `[HA] Registered custom provider: ${customProvider.id} with ${mirroredModels.length} models`
    );
  }
}

// =============================================================================
// Failover Logic
// =============================================================================

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

    // Skip if this entry is currently exhausted
    if (isExhausted(entry.id)) {
      console.log(`[HA] Skipping exhausted entry: ${entry.id}`);
      continue;
    }

    // Get available models for this provider
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
      // Pick the first available model (or try to match capability tier)
      selectedModel = availableModels[0];
    }

    // Check if we have auth for this model
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
  // Load configuration
  config = loadConfig();

  if (!config) {
    console.log("[HA] No ha.json found. Run /ha-init to create one.");
    return;
  }

  // Register custom providers for backup OAuth accounts
  registerCustomProviders(pi, config);

  // Set initial active group
  if (config.defaultGroup && config.groups[config.defaultGroup]) {
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
        ctx.ui.notify("HA configuration already exists at ~/.pi/ha.json", "warning");
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
      ctx.ui.notify("Created ~/.pi/ha.json. Edit it to configure your failover groups.", "info");
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
      state.exhausted.clear(); // Clear exhausted state when switching groups
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
          const status = exhausted ? "❌ exhausted" : "✅ available";
          lines.push(`  ${entry.id} - ${status}`);
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

  // =============================================================================
  // Failover Hook
  // =============================================================================

  pi.on("turn_end", async (event, ctx) => {
    // Skip if no config or no active group
    if (!config || !state.activeGroup) return;

    // Skip if we're already in a retry (prevent loops)
    if (state.isRetrying) return;

    // Check if this turn resulted in a quota error
    const message = event.message;
    if (!message || message.role !== "assistant") return;

    // Check for error stop reason or error message
    const hasError = message.stopReason === "error" || message.errorMessage;
    if (!hasError) return;

    // Check if it's a quota or capacity error
    const currentModel = ctx.model;
    const currentProvider = currentModel?.provider;

    if (!shouldTriggerFailover(message.errorMessage, currentProvider)) {
      console.log(`[HA] Error detected but not failover-worthy: ${message.errorMessage}`);
      return;
    }

    console.log(`[HA] Failover error detected: ${message.errorMessage}`);

    // Mark current provider as exhausted
    const currentModel = ctx.model;
    if (currentModel) {
      const currentEntryId = `${currentModel.provider}/${currentModel.id}`;
      const globalDefaultCooldown = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
      markExhausted(currentEntryId, globalDefaultCooldown);
      console.log(`[HA] Marked ${currentEntryId} as exhausted`);
    }

    // Find next available provider
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
    // Clear retry state when a new turn starts successfully
    if (state.lastRetryMessage && !state.isRetrying) {
      state.lastRetryMessage = null;
    }
  });

  console.log("[HA] High Availability extension loaded");
}
