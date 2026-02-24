/**
 * High Availability Provider Extension for Pi
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// =============================================================================
// Types & Config
// =============================================================================

interface HaGroupEntry { id: string; cooldownMs?: number; }
interface HaGroup { name: string; entries: HaGroupEntry[]; }
interface HaConfig {
  groups: Record<string, HaGroup>;
  defaultGroup?: string;
  defaultCooldownMs?: number;
  credentials?: Record<string, Record<string, any>>;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "ha.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");

const state = {
  activeGroup: null as string | null,
  exhausted: new Map<string, { exhaustedAt: number, cooldownMs: number }>(),
  isRetrying: false,
  activeCredential: new Map<string, string>(),
};

let config: HaConfig | null = null;

// =============================================================================
// Helper Functions
// =============================================================================

function loadAuthJson() {
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf-8")); }
  catch { return {}; }
}

function saveAuthJson(auth: any) {
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), "utf-8");
}

function syncAuthToHa() {
  if (!config) return;
  const auth = loadAuthJson();
  if (!config.credentials) config.credentials = {};
  let changed = false;

  for (const [providerId, creds] of Object.entries(auth)) {
    if (!config.credentials[providerId]) config.credentials[providerId] = {};
    const stored = config.credentials[providerId];
    
    let foundName = null;
    for (const [name, existing] of Object.entries(stored)) {
      if ((creds as any).refresh && (creds as any).refresh === existing.refresh) { foundName = name; break; }
      if ((creds as any).key && (creds as any).key === existing.key) { foundName = name; break; }
    }

    if (!foundName) {
      const name = stored["primary"] ? `backup-${Object.keys(stored).length}` : "primary";
      stored[name] = JSON.parse(JSON.stringify(creds));
      changed = true;
      console.log(`[HA] Synced ${name} for ${providerId}`);
      state.activeCredential.set(providerId, name);
    } else {
      // Correctly track which specific backup is currently in auth.json
      state.activeCredential.set(providerId, foundName);
    }
  }
  if (changed) writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function switchCred(providerId: string, name: string) {
  if (!config?.credentials?.[providerId]?.[name]) return false;
  const auth = loadAuthJson();
  auth[providerId] = JSON.parse(JSON.stringify(config.credentials[providerId][name]));
  saveAuthJson(auth);
  state.activeCredential.set(providerId, name);
  return true;
}

export default function (pi: ExtensionAPI) {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (config?.defaultGroup) state.activeGroup = config.defaultGroup;
    syncAuthToHa();
  } catch {}

  pi.registerCommand("ha-status", {
    description: "HA Status",
    handler: async (_, ctx) => {
      const lines = [`Active Group: ${state.activeGroup}`];
      if (config?.credentials) {
        lines.push("\nStored Credentials:");
        for (const [p, creds] of Object.entries(config.credentials)) {
          const active = state.activeCredential.get(p) || "primary";
          lines.push(`  ${p}: ${Object.keys(creds).join(", ")} (Active: ${active})`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });

  pi.registerCommand("ha-sync", {
    description: "Sync Credentials",
    handler: async (_, ctx) => { syncAuthToHa(); ctx.ui.notify("Synced!", "info"); }
  });

  pi.registerCommand("ha-mock-error", {
    handler: async () => { pi.sendUserMessage("MOCK_FAILOVER_TRIGGER", { deliverAs: "steer" }); }
  });

  pi.on("turn_start", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const lastMessage = branch.slice().reverse().find((e: any) => e.type === "message");
    const content = lastMessage?.message?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);

    if (text && text.includes("MOCK_FAILOVER_TRIGGER")) {
      const providerId = ctx.model?.provider;
      if (providerId && config?.credentials?.[providerId]) {
        const stored = config.credentials[providerId];
        const names = Object.keys(stored);
        const current = state.activeCredential.get(providerId) || "primary";
        const next = names[(names.indexOf(current) + 1) % names.length];
        
        if (next && next !== current) {
          if (switchCred(providerId, next)) {
            ctx.ui.notify(`⚠️ MOCK FAILOVER: Switching ${providerId} to ${next}...`, "warning");
            const actualMessage = branch.slice().reverse().find((e: any) => 
              e.type === "message" && e.message.role === "user" && !JSON.stringify(e.message.content).includes("MOCK_FAILOVER_TRIGGER")
            );
            if (actualMessage) pi.sendUserMessage(actualMessage.message.content, { deliverAs: "steer" });
            return;
          }
        }
      }
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!config || !state.activeGroup || state.isRetrying) return;
    const msg = event.message;
    if (msg?.role !== "assistant") return;

    const isError = msg.errorMessage && (msg.errorMessage.includes("429") || msg.errorMessage.toLowerCase().includes("quota") || msg.errorMessage.toLowerCase().includes("capacity"));
    if (!isError) return;

    const providerId = ctx.model?.provider;
    if (!providerId) return;

    const stored = config.credentials?.[providerId];
    if (stored) {
      const names = Object.keys(stored);
      const current = state.activeCredential.get(providerId) || "primary";
      const next = names[(names.indexOf(current) + 1) % names.length];
      if (next && next !== current) {
        if (switchCred(providerId, next)) {
          ctx.ui.notify(`⚠️ Switching ${providerId} to ${next}...`, "warning");
          state.isRetrying = true;
          const lastUser = ctx.sessionManager.getBranch().slice().reverse().find((e: any) => e.type === "message" && e.message.role === "user");
          if (lastUser) pi.sendUserMessage(lastUser.message.content, { deliverAs: "steer" });
          setTimeout(() => state.isRetrying = false, 5000);
          return;
        }
      }
    }
    // Logic for jumping to next provider in group would go here if accounts are exhausted
  });
}
