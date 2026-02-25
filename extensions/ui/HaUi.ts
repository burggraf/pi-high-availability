import { ExtensionContext, DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, Key, matchesKey, Spacer, CURSOR_MARKER } from "@mariozechner/pi-tui";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Accordion, AccordionSection } from "./Accordion";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const AUTH_PATH = join(AGENT_DIR, "auth.json");

const state = {
  activeCredential: new Map<string, string>(),
};

function loadAuthJson() {
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf-8")); }
  catch { return {}; }
}

function updateActiveCredentialsFromAuth(config: HaConfig) {
  if (!config?.credentials) return;
  const auth = loadAuthJson();
  
  for (const [providerId, currentAuth] of Object.entries(auth)) {
    const stored = config.credentials[providerId];
    if (!stored) continue;

    for (const [name, cred] of Object.entries(stored)) {
      if (name === "type") continue;
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

interface HaGroupEntry { id: string; cooldownMs?: number; }
interface HaGroup { name: string; entries: HaGroupEntry[]; }
interface HaConfig {
  groups: Record<string, HaGroup>;
  defaultGroup?: string;
  defaultCooldownMs?: number;
  credentials?: Record<string, Record<string, any>>;
}

export class HaUi {
  private config: HaConfig;
  private activeGroup: string | null = null;
  private view: "main" | "input" | "confirm" = "main";
  private accordion: Accordion;
  private onDone: (result: any) => void;
  private ctx: ExtensionContext;
  
  // Input state
  private inputLabel = "";
  private inputValue = "";
  private inputCallback: (val: string) => void = () => {};

  // Confirmation state
  private confirmMessage = "";
  private confirmCallback: () => void = () => {};

  constructor(ctx: ExtensionContext, config: HaConfig, activeGroup: string | null, onDone: (result: any) => void) {
    this.ctx = ctx;
    this.config = JSON.parse(JSON.stringify(config));
    this.activeGroup = activeGroup;
    this.onDone = onDone;
    updateActiveCredentialsFromAuth(this.config);

    this.accordion = new Accordion(this.buildSections(), ctx.ui.theme, (id) => this.handleAction(id));
  }

  private buildSections(): AccordionSection[] {
    const sections: AccordionSection[] = [];
    const theme = this.ctx.ui.theme;

    // --- Groups Section ---
    const groupItems: any[] = [];
    Object.entries(this.config.groups).forEach(([name, group]) => {
      const isDefault = name === this.config.defaultGroup;
      const isActive = name === this.activeGroup;
      const status = (isActive ? "● " : "○ ") + (isDefault ? "🎯 " : "");
      
      groupItems.push({
        id: `group-${name}`,
        label: `${status}${name} (${group.entries.length} models)`,
        action: () => {
          this.activeGroup = name;
          this.accordion.setSections(this.buildSections());
        }
      });
      
      group.entries.forEach((entry, idx) => {
        const cooldown = entry.cooldownMs ? ` [${entry.cooldownMs}ms]` : "";
        groupItems.push({
          id: `entry-${name}-${idx}`,
          label: `  ${idx + 1}. ${entry.id}${cooldown}`,
          action: () => {
            this.showInput(`Cooldown for ${entry.id}`, (entry.cooldownMs || "").toString(), (val) => {
              const num = parseInt(val);
              if (!isNaN(num)) entry.cooldownMs = num;
              else delete entry.cooldownMs;
              this.accordion.setSections(this.buildSections());
            });
          },
          onDelete: () => {
            this.showConfirm(`Remove model '${entry.id}' from group '${name}'?`, () => {
              group.entries.splice(idx, 1);
              this.accordion.setSections(this.buildSections());
            });
          }
        });
      });
      
      groupItems.push({
        id: `add-model-${name}`,
        label: `  + Add Model to ${name}`,
        action: () => {
          this.showInput("Model ID", "", (id) => {
            if (id) {
              group.entries.push({ id });
              this.accordion.setSections(this.buildSections());
            }
          });
        }
      });

      groupItems.push({
        id: `delete-group-${name}`,
        label: `  🗑️ Delete Group ${name}`,
        action: () => {
          this.showConfirm(`Delete group '${name}' and all its entries?`, () => {
            delete this.config.groups[name];
            if (this.config.defaultGroup === name) delete this.config.defaultGroup;
            if (this.activeGroup === name) this.activeGroup = null;
            this.accordion.setSections(this.buildSections());
          });
        }
      });
      groupItems.push({ id: `spacer-group-${name}`, label: "", action: () => {} });
    });

    groupItems.push({
      id: "add-group",
      label: "+ Add Group",
      action: () => {
        this.showInput("Group Name", "", (name) => {
          if (name && !this.config.groups[name]) {
            this.config.groups[name] = { name, entries: [] };
            this.accordion.setSections(this.buildSections());
          }
        });
      }
    });

    sections.push({
      id: "groups",
      label: "📂 Groups",
      description: `${Object.keys(this.config.groups).length} configured`,
      content: new Container(), 
      items: groupItems
    });

    // --- Credentials Section ---
    const credItems: any[] = [];
    if (this.config.credentials) {
      Object.entries(this.config.credentials).forEach(([provider, creds]) => {
        // Detect if this provider is an OAuth provider (has entries with refresh tokens)
        const isOAuth = Object.values(creds).some(c => c && typeof c === 'object' && 'refresh' in c);
        
        credItems.push({ 
          id: `provider-${provider}`, 
          label: `🔌 ${provider}${isOAuth ? " (OAuth)" : ""}`, 
          action: () => {} 
        });
        
        Object.entries(creds).forEach(([name, cred]) => {
          if (name === "type") return;
          const isActive = state.activeCredential.get(provider) === name;
          const status = isActive ? "● " : "○ ";
          credItems.push({
            id: `cred-${provider}-${name}`,
            label: `  ${status}${name}`,
            action: () => {
              state.activeCredential.set(provider, name);
              this.accordion.setSections(this.buildSections());
            },
            onDelete: () => {
              this.showConfirm(`Delete key '${name}' for provider '${provider}'?`, () => {
                delete this.config.credentials![provider][name];
                this.accordion.setSections(this.buildSections());
              });
            }
          });
        });

        // Only show "Add Key" for non-OAuth providers
        if (!isOAuth) {
          credItems.push({
            id: `add-key-${provider}`,
            label: `  + Add API Key to ${provider}`,
            action: () => {
              this.showInput("API Key", "", (key) => {
                if (key) {
                  const stored = this.config.credentials![provider];
                  const count = Object.keys(stored).filter(k => k !== "type").length;
                  const name = stored["primary"] ? `backup-${count}` : "primary";
                  stored[name] = { key, type: "api_key" };
                  this.accordion.setSections(this.buildSections());
                }
              });
            }
          });
        }

        credItems.push({
          id: `delete-provider-${provider}`,
          label: `  🗑️ Delete Provider ${provider}`,
          action: () => {
            this.showConfirm(`Delete provider '${provider}' and all its keys?`, () => {
              delete this.config.credentials![provider];
              this.accordion.setSections(this.buildSections());
            });
          }
        });
        credItems.push({ id: `spacer-provider-${provider}`, label: "", action: () => {} });
      });
    }

    credItems.push({
      id: "add-provider-info",
      label: theme.fg("dim", "💡 To add OAuth accounts, run /login in pi"),
      action: () => {}
    });

    credItems.push({
      id: "add-provider",
      label: "+ Add API Provider",
      action: () => {
        this.showInput("Provider ID (e.g. anthropic, openai)", "", (pid) => {
          if (pid) {
            if (!this.config.credentials) this.config.credentials = {};
            if (!this.config.credentials[pid]) this.config.credentials[pid] = {};
            this.accordion.setSections(this.buildSections());
          }
        });
      }
    });

    credItems.push({
      id: "sync-auth",
      label: "🔄 Sync from auth.json",
      action: () => {
        updateActiveCredentialsFromAuth(this.config);
        this.accordion.setSections(this.buildSections());
      }
    });

    sections.push({
      id: "credentials",
      label: "🔑 Credentials",
      description: `${Object.keys(this.config.credentials || {}).length} providers`,
      content: new Container(),
      items: credItems
    });

    // --- Settings Section ---
    const settingsItems = [
      {
        id: "set-default-group",
        label: `🎯 Default Group: ${this.config.defaultGroup || "None"}`,
        action: () => {
          const names = Object.keys(this.config.groups);
          if (names.length > 0) {
            const current = this.config.defaultGroup || "";
            const nextIdx = (names.indexOf(current) + 1) % names.length;
            this.config.defaultGroup = names[nextIdx];
            this.accordion.setSections(this.buildSections());
          }
        }
      },
      {
        id: "set-cooldown",
        label: `⏱️ Default Cooldown: ${this.config.defaultCooldownMs || 0}ms`,
        action: () => {
          this.showInput("Default Cooldown", (this.config.defaultCooldownMs || 0).toString(), (val) => {
            const num = parseInt(val);
            if (!isNaN(num)) this.config.defaultCooldownMs = num;
            this.accordion.setSections(this.buildSections());
          });
        }
      }
    ];

    sections.push({
      id: "settings",
      label: "⚙️ Settings",
      content: new Container(),
      items: settingsItems
    });

    // --- Actions ---
    sections.push({
      id: "actions",
      label: "🚀 Finish",
      content: new Container(),
      items: [
        { id: "save", label: "💾 Save & Exit", action: () => {
          this.onDone({ action: "save", config: this.config, activeGroup: this.activeGroup });
        } },
        { id: "cancel", label: "❌ Cancel", action: () => {
          this.onDone(null);
        } }
      ]
    });

    sections.push({
      id: "help",
      label: "❓ Help",
      content: new Container(),
      items: [
        { id: "login-info", label: "🔑 How to add OAuth?", action: () => {
          this.ctx.ui.notify("Run /login in the main editor to add Google, Claude, or ChatGPT Plus accounts.", "info");
        } }
      ]
    });

    return sections;
  }

  private handleAction(id: string) {
    // No-op for now
  }

  private showInput(label: string, initial: string, callback: (val: string) => void) {
    this.view = "input";
    this.inputLabel = label;
    this.inputValue = initial;
    this.inputCallback = callback;
  }

  private showConfirm(message: string, callback: () => void) {
    this.view = "confirm";
    this.confirmMessage = message;
    this.confirmCallback = callback;
  }

  render(width: number): string[] {
    const container = new Container();
    const theme = this.ctx.ui.theme;
    
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    
    if (this.view === "input") {
      container.addChild(new Text(theme.fg("accent", theme.bold(` ${this.inputLabel} `)), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(`> ${this.inputValue}${CURSOR_MARKER}\x1b[7m \x1b[27m`, 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", " enter confirm • esc cancel "), 1, 0));
    } else if (this.view === "confirm") {
      container.addChild(new Text(theme.fg("warning", theme.bold(" Confirmation Needed ")), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(this.confirmMessage, 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", " y confirm • n/esc cancel "), 1, 0));
    } else {
      container.addChild(new Text(theme.fg("accent", theme.bold(" High Availability Manager ")), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(this.accordion);
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • space toggle • enter select • x delete • esc exit "), 1, 0));
    }

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return container.render(width);
  }

  handleInput(data: string, tui: any): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "input" || this.view === "confirm") {
        this.view = "main";
      } else {
        this.onDone(null);
      }
    } else if (this.view === "input") {
      if (matchesKey(data, Key.enter)) {
        this.inputCallback(this.inputValue);
        this.view = "main";
      } else if (matchesKey(data, Key.backspace)) {
        this.inputValue = this.inputValue.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.inputValue += data;
      }
    } else if (this.view === "confirm") {
      if (data.toLowerCase() === "y") {
        this.confirmCallback();
        this.view = "main";
      } else if (data.toLowerCase() === "n") {
        this.view = "main";
      }
    } else {
      this.accordion.handleInput(data);
    }
    tui.requestRender();
  }

  invalidate() {
    this.accordion.invalidate();
  }
}
