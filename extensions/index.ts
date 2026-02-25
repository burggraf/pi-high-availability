/**
 * High Availability Provider Extension for Pi
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { HaUi } from "./ui/HaUi";

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

function loadAuthJson() {
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf-8")); }
  catch { return {}; }
}

function saveAuthJson(auth: any) {
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), "utf-8");
}

function saveConfig(cfg: HaConfig) {
  config = cfg;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
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
      if (name === "type") continue;
      if ((creds as any).refresh && (creds as any).refresh === existing.refresh) { foundName = name; break; }
      if ((creds as any).key && (creds as any).key === existing.key) { foundName = name; break; }
    }

    if (!foundName) {
      const name = stored["primary"] ? `backup-${Object.keys(stored).filter(k => k !== "type").length}` : "primary";
      const newCred = JSON.parse(JSON.stringify(creds));
      if ((creds as any).refresh) newCred.type = "oauth";
      else if ((creds as any).key) newCred.type = "api_key";
      
      stored[name] = newCred;
      changed = true;
      console.log(`[HA] Synced ${name} for ${providerId}`);
      state.activeCredential.set(providerId, name);
    } else {
      state.activeCredential.set(providerId, foundName);
    }
  }
  if (changed) saveConfig(config);
}

function switchCred(providerId: string, name: string) {
  if (!config?.credentials?.[providerId]?.[name]) return false;
  const auth = loadAuthJson();
  
  // Clone the stored credential but exclude the HA-specific 'type' field 
  // if you want auth.json to remain pristine, although pi handles extra fields fine.
  const credToSave = JSON.parse(JSON.stringify(config.credentials[providerId][name]));
  
  auth[providerId] = credToSave;
  saveAuthJson(auth);
  state.activeCredential.set(providerId, name);
  return true;
}

function updateActiveCredentialsFromAuth() {
  if (!config?.credentials) return;
  const auth = loadAuthJson();
  
  for (const [providerId, currentAuth] of Object.entries(auth)) {
    const stored = config.credentials[providerId];
    if (!stored) continue;

    for (const [name, cred] of Object.entries(stored)) {
      if (name === "type") continue;
      // Match by key or refresh token
      if ((currentAuth as any).key && (currentAuth as any).key === (cred as any).key) {
        state.activeCredential.set(providerId, name);
        break;
      }
      if ((currentAuth as any).refresh && (currentAuth as any).refresh === (cred as any).refresh) {
        state.activeCredential.set(providerId, name);
        break;
      }
    }
  }
}

export default function (pi: ExtensionAPI) {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (config?.defaultGroup) state.activeGroup = config.defaultGroup;
    syncAuthToHa();
    updateActiveCredentialsFromAuth();
  } catch {}

  pi.registerCommand("ha", {
    description: "High Availability Manager UI",
    handler: async (_, ctx) => {
      if (!config) {
        config = { groups: {}, credentials: {}, defaultCooldownMs: 5000 };
        saveConfig(config);
      }
      
      syncAuthToHa(); // Ensure we are up-to-date with auth.json on open

      const loop = async () => {
          const result = await ctx.ui.custom<any | null>(
            (tui, theme, _kb, done) => {
              const haUi = new HaUi(ctx, config!, state.activeGroup, (res) => done(res));
              return {
                render: (w) => haUi.render(w),
                handleInput: (data) => haUi.handleInput(data, tui),
                invalidate: () => haUi.invalidate(),
              };
            }
          );

          if (!result) return;

          if (result.action === "sync") {
              saveConfig(result.config);
              syncAuthToHa();
              ctx.ui.notify("Synced credentials from auth.json", "info");
              await loop();
          } else if (result.action === "activate") {
              saveConfig(result.config);
              if (switchCred(result.provider, result.name)) {
                ctx.ui.notify(`Activated ${result.name} for ${result.provider}`, "info");
              }
              await loop();
          } else if (result.action === "oauth") {
              saveConfig(result.config);
              ctx.ui.notify(`Running /login...`, "info");
              await pi.sendUserMessage("/login", { deliverAs: "steer" });
          } else {
              saveConfig(result.config);
              state.activeGroup = result.activeGroup;
              ctx.ui.notify("HA configuration saved.", "info");
          }
      };

      await loop();
    }
  });

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

    const isError = msg.errorMessage && (
      msg.errorMessage.includes("429") || 
      msg.errorMessage.toLowerCase().includes("quota") || 
      msg.errorMessage.toLowerCase().includes("capacity")
    );
    if (!isError) return;

    const providerId = ctx.model?.provider;
    if (!providerId) return;

    const group = config.groups[state.activeGroup];
    if (!group) return;

    // 1. Try to rotate credentials for the CURRENT provider first
    const stored = config.credentials?.[providerId];
    if (stored) {
      const names = Object.keys(stored).filter(k => k !== "type");
      const currentCred = state.activeCredential.get(providerId) || "primary";
      
      // Mark current cred as exhausted
      const cooldown = config.defaultCooldownMs || 3600000;
      state.exhausted.set(`${providerId}:${currentCred}`, { exhaustedAt: Date.now(), cooldownMs: cooldown });

      // Find next non-exhausted credential
      for (let i = 1; i <= names.length; i++) {
        const nextIdx = (names.indexOf(currentCred) + i) % names.length;
        const nextName = names[nextIdx];
        
        const exhaustState = state.exhausted.get(`${providerId}:${nextName}`);
        const isStillExhausted = exhaustState && (Date.now() - exhaustState.exhaustedAt < exhaustState.cooldownMs);
        
        if (!isStillExhausted) {
          if (switchCred(providerId, nextName)) {
            ctx.ui.notify(`⚠️ Quota hit. Switching ${providerId} account to ${nextName}...`, "warning");
            retryTurn(ctx);
            return;
          }
        }
      }
    }

    // 2. If all credentials for current provider fail, switch to NEXT provider in the group
    const currentModelId = `${ctx.model?.provider}/${ctx.model?.id}`;
    const entries = group.entries;
    
    // Note: User's ha.json has provider IDs as entries. We should support both provider IDs and full model IDs.
    const findEntryIndex = () => {
        const idx = entries.findIndex(e => e.id === currentModelId || e.id === providerId);
        return idx;
    };

    const currentEntryIdx = findEntryIndex();
    for (let i = 1; i <= entries.length; i++) {
        const nextEntryIdx = (currentEntryIdx + i) % entries.length;
        const nextEntry = entries[nextEntryIdx];
        
        // If it's just a provider name, we try to find a model for it
        let targetModel = ctx.modelRegistry.find(nextEntry.id, ""); // Placeholder
        if (!targetModel) {
            // Try to find ANY available model for this provider
            const allModels = ctx.modelRegistry.getAll();
            targetModel = allModels.find(m => m.provider === nextEntry.id || `${m.provider}/${m.id}` === nextEntry.id);
        }

        if (targetModel) {
            const nextProviderId = targetModel.provider;
            
            // Switch to primary cred for the new provider
            switchCred(nextProviderId, "primary");
            
            if (await pi.setModel(targetModel)) {
                ctx.ui.notify(`🚨 All ${providerId} accounts exhausted. Failing over to ${nextProviderId}...`, "error");
                retryTurn(ctx);
                return;
            }
        }
    }
  });

  function retryTurn(ctx: any) {
    state.isRetrying = true;
    const branch = ctx.sessionManager.getBranch();
    const lastUser = branch.slice().reverse().find((e: any) => e.type === "message" && e.message.role === "user");
    if (lastUser) {
        pi.sendUserMessage(lastUser.message.content, { deliverAs: "steer" });
    }
    setTimeout(() => state.isRetrying = false, 5000);
  }
}
