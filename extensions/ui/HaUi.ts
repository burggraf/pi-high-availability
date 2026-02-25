
import { ExtensionAPI, ExtensionContext, DynamicBorder, getSelectListTheme } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, SelectItem, Text, Key, matchesKey, Box, Spacer, Input, CURSOR_MARKER } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Access state from index.ts
const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "ha.json");
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
  private selectedIndex = 0;
  private view: "main" | "groups" | "credentials" | "provider-creds" | "group-entries" | "input" | "entry-options" | "cred-options" | "add-provider-type" | "select-provider" = "main";
  private previousView: any = null;
  private currentProvider: string | null = null;
  private currentGroup: string | null = null;
  private currentEntryIdx: number | null = null;
  private currentCredName: string | null = null;
  private currentList: SelectItem[] = [];
  private onDone: (result: any) => void;
  private ctx: ExtensionContext;
  
  // Input state
  private inputLabel = "";
  private inputValue = "";
  private inputCallback: (val: string) => void = () => {};

  constructor(ctx: ExtensionContext, config: HaConfig, activeGroup: string | null, onDone: (result: any) => void) {
    this.ctx = ctx;
    this.config = JSON.parse(JSON.stringify(config));
    this.activeGroup = activeGroup;
    this.onDone = onDone;
    updateActiveCredentialsFromAuth(this.config);
    this.updateMainList();
  }

  private updateMainList() {
    this.view = "main";
    this.currentList = [
      { value: "groups", label: "📂 Groups", description: `Manage model groups (${Object.keys(this.config.groups || {}).length})` },
      { value: "credentials", label: "🔑 Credentials", description: `Manage provider credentials (${Object.keys(this.config.credentials || {}).length} providers)` },
      { value: "defaultGroup", label: "🎯 Default Group", description: `Current: ${this.config.defaultGroup || "None"}` },
      { value: "cooldown", label: "⏱️ Default Cooldown", description: `${this.config.defaultCooldownMs || 0}ms` },
      { value: "save", label: "💾 Save & Exit" },
      { value: "cancel", label: "❌ Cancel" },
    ];
  }

  private updateGroupsList() {
    this.view = "groups";
    this.currentList = Object.keys(this.config.groups || {}).map(name => ({
      value: name,
      label: (name === this.activeGroup ? "● " : "○ ") + name,
      description: `${this.config.groups[name].entries.length} entries`
    }));
    this.currentList.push({ value: "__add__", label: "+ Add Group" });
    this.currentList.push({ value: "__back__", label: "← Back" });
  }

  private updateGroupEntriesList(groupName: string) {
    this.view = "group-entries";
    this.currentGroup = groupName;
    const group = this.config.groups[groupName];
    this.currentList = group.entries.map((entry, idx) => ({
      value: `entry-${idx}`,
      label: `[${idx + 1}] ${entry.id}`,
      description: entry.cooldownMs ? `Cooldown: ${entry.cooldownMs}ms` : "Default cooldown"
    }));
    this.currentList.push({ value: "__add_entry__", label: "+ Add Entry" });
    this.currentList.push({ value: "__rename__", label: "✏️ Rename Group" });
    this.currentList.push({ value: "__delete__", label: "🗑️ Delete Group" });
    this.currentList.push({ value: "__back__", label: "← Back" });
  }

  private updateEntryOptionsList(idx: number) {
      this.view = "entry-options";
      this.currentEntryIdx = idx;
      const entry = this.config.groups[this.currentGroup!].entries[idx];
      this.currentList = [
          { value: "cooldown", label: "⏱️ Set Cooldown", description: `Current: ${entry.cooldownMs || "Default"}` },
          { value: "delete", label: "🗑️ Remove Entry" },
          { value: "__back__", label: "← Back" }
      ];
  }

  private updateCredentialOptionsList(name: string) {
      this.view = "cred-options";
      this.currentCredName = name;
      
      const isActive = state.activeCredential.get(this.currentProvider!) === name;
      
      this.currentList = [
          { value: "activate", label: isActive ? "● Active" : "○ Activate", description: "Set as active in auth.json" },
          { value: "delete", label: "🗑️ Remove Credential" },
          { value: "__back__", label: "← Back" }
      ];
  }

  private updateCredentialsList() {
    this.view = "credentials";
    this.currentList = Object.keys(this.config.credentials || {}).map(provider => ({
      value: provider,
      label: `🔌 ${provider}`,
      description: `${Object.keys(this.config.credentials![provider]).length} keys`
    }));
    this.currentList.push({ value: "__add_provider__", label: "+ Add Provider" });
    this.currentList.push({ value: "__sync__", label: "🔄 Sync from auth.json" });
    this.currentList.push({ value: "__back__", label: "← Back" });
  }

  private updateProviderCredsList(provider: string) {
    this.view = "provider-creds";
    this.currentProvider = provider;
    const creds = this.config.credentials![provider] || {};
    
    // Sort keys to maintain order (primary first, then backups)
    const sortedKeys = Object.keys(creds).sort((a, b) => {
        if (a === "primary") return -1;
        if (b === "primary") return 1;
        return a.localeCompare(b);
    });

    this.currentList = sortedKeys.map(name => ({
      value: name,
      label: `🔑 ${name}`,
      description: name === "primary" ? "Main credential" : "Backup credential"
    }));
    this.currentList.push({ value: "__add_api_key__", label: "+ Add API Key" });
    this.currentList.push({ value: "__add_oauth__", label: "+ Add OAuth (/login)" });
    this.currentList.push({ value: "__delete_provider__", label: "🗑️ Delete Provider" });
    this.currentList.push({ value: "__back__", label: "← Back" });
  }

  private updateAddProviderTypeList() {
      this.view = "add-provider-type";
      this.currentList = [
          { value: "api_key", label: "🔑 API Key", description: "Standard API key authentication" },
          { value: "oauth", label: "🌐 OAuth / SSO", description: "Browser-based login" },
          { value: "__back__", label: "← Back" }
      ];
  }

  private updateSelectProviderList(type: "api_key" | "oauth") {
      this.view = "select-provider";
      
      const allModels = this.ctx.modelRegistry.getAll();
      const providers = new Set<string>();
      
      for (const model of allModels) {
          providers.add(model.provider);
      }

      this.currentList = Array.from(providers).map(p => ({
          value: p,
          label: p,
          description: type === "api_key" ? `Standard API Key` : `OAuth / SSO`
      }));
      
      if (type === "api_key") {
          this.currentList.push({ value: "__custom__", label: "+ Custom Provider", description: "Enter provider ID manually" });
      }

      this.currentList.push({ value: "__back__", label: "← Back" });
  }

  private showInput(label: string, initial: string, callback: (val: string) => void) {
    this.previousView = { view: this.view, selectedIndex: this.selectedIndex };
    this.view = "input";
    this.inputLabel = label;
    this.inputValue = initial;
    this.inputCallback = callback;
  }

  render(width: number, theme: any): string[] {
    const container = new Container();
    
    // Header
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    
    if (this.view === "input") {
      container.addChild(new Text(theme.fg("accent", theme.bold(` ${this.inputLabel} `)), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(`> ${this.inputValue}${CURSOR_MARKER}\x1b[7m \x1b[27m`, 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", " enter confirm • esc cancel "), 1, 0));
    } else {
      let title = "High Availability Manager";
      if (this.view === "groups") title = "HA Groups";
      if (this.view === "group-entries") title = `Group: ${this.currentGroup}`;
      if (this.view === "entry-options") title = `Entry: ${this.config.groups[this.currentGroup!].entries[this.currentEntryIdx!].id}`;
      if (this.view === "credentials") title = "HA Credentials";
      if (this.view === "provider-creds") title = `Provider: ${this.currentProvider}`;
      if (this.view === "cred-options") title = `Credential: ${this.currentCredName}`;
      if (this.view === "add-provider-type") title = "Select Auth Type";
      if (this.view === "select-provider") title = "Select Provider";

      container.addChild(new Text(theme.fg("accent", theme.bold(` ${title} `)), 1, 0));
      
      const selectList = new SelectList(this.currentList, 12, {
        ...getSelectListTheme(),
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
      });
      selectList.setSelectedIndex(this.selectedIndex);
      container.addChild(selectList);

      container.addChild(new Spacer(1));
      let help = " ↑↓ navigate • enter select • esc back/cancel ";
      if (this.view === "group-entries" || this.view === "provider-creds") {
          help += "• u/d move ";
      }
      container.addChild(new Text(theme.fg("dim", help), 1, 0));
    }
    
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return container.render(width);
  }

  handleInput(data: string, tui: any) {
    if (this.view === "input") {
      if (matchesKey(data, Key.enter)) {
        const val = this.inputValue.trim();
        this.view = this.previousView.view;
        this.selectedIndex = this.previousView.selectedIndex;
        this.inputCallback(val);
      } else if (matchesKey(data, Key.escape)) {
        this.view = this.previousView.view;
        this.selectedIndex = this.previousView.selectedIndex;
      } else if (matchesKey(data, Key.backspace)) {
        this.inputValue = this.inputValue.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.inputValue += data;
      }
      tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      tui.requestRender();
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.currentList.length - 1, this.selectedIndex + 1);
      tui.requestRender();
    } else if (data === "u" || data === "d") {
        this.handleMove(data === "u" ? -1 : 1, tui);
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.currentList[this.selectedIndex];
      if (selected) this.handleSelect(selected.value, tui);
    } else if (matchesKey(data, Key.escape)) {
      this.handleBack(tui);
    }
  }

  private handleMove(dir: number, tui: any) {
      if (this.view === "group-entries") {
          const entries = this.config.groups[this.currentGroup!].entries;
          const idx = this.selectedIndex;
          if (idx < entries.length) {
              const newIdx = idx + dir;
              if (newIdx >= 0 && newIdx < entries.length) {
                  const [item] = entries.splice(idx, 1);
                  entries.splice(newIdx, 0, item);
                  this.selectedIndex = newIdx;
                  this.updateGroupEntriesList(this.currentGroup!);
              }
          }
      } else if (this.view === "provider-creds") {
          const creds = this.config.credentials![this.currentProvider!];
          const keys = Object.keys(creds).sort((a, b) => {
              if (a === "primary") return -1;
              if (b === "primary") return 1;
              return a.localeCompare(b);
          });
          const idx = this.selectedIndex;
          if (idx < keys.length) {
              const newIdx = idx + dir;
              if (newIdx >= 0 && newIdx < keys.length) {
                  const keyA = keys[idx];
                  const keyB = keys[newIdx];
                  const temp = creds[keyA];
                  creds[keyA] = creds[keyB];
                  creds[keyB] = temp;
                  this.selectedIndex = newIdx;
                  this.updateProviderCredsList(this.currentProvider!);
              }
          }
      }
      tui.requestRender();
  }

  private handleBack(tui: any) {
    if (this.view === "main") {
      this.onDone(null);
    } else if (this.view === "groups" || this.view === "credentials") {
      this.updateMainList();
      this.selectedIndex = 0;
    } else if (this.view === "group-entries") {
      this.updateGroupsList();
      this.selectedIndex = 0;
    } else if (this.view === "provider-creds") {
      this.updateCredentialsList();
      this.selectedIndex = 0;
    } else if (this.view === "entry-options") {
        this.updateGroupEntriesList(this.currentGroup!);
        this.selectedIndex = 0;
    } else if (this.view === "cred-options") {
        this.updateProviderCredsList(this.currentProvider!);
        this.selectedIndex = 0;
    } else if (this.view === "add-provider-type") {
        this.updateCredentialsList();
        this.selectedIndex = 0;
    } else if (this.view === "select-provider") {
        this.updateAddProviderTypeList();
        this.selectedIndex = 0;
    }
    tui.requestRender();
  }

  private handleSelect(value: string, tui: any) {
    if (this.view === "main") {
      if (value === "groups") {
        this.updateGroupsList();
        this.selectedIndex = 0;
      } else if (value === "credentials") {
        this.updateCredentialsList();
        this.selectedIndex = 0;
      } else if (value === "save") {
        this.onDone({ config: this.config, activeGroup: this.activeGroup });
      } else if (value === "cancel") {
        this.onDone(null);
      } else if (value === "defaultGroup") {
        const names = Object.keys(this.config.groups);
        if (names.length > 0) {
            const current = this.config.defaultGroup || "";
            const nextIdx = (names.indexOf(current) + 1) % names.length;
            this.config.defaultGroup = names[nextIdx];
            this.updateMainList();
        }
      } else if (value === "cooldown") {
        this.showInput("Default Cooldown (ms)", (this.config.defaultCooldownMs || 0).toString(), (val) => {
            const num = parseInt(val);
            if (!isNaN(num)) this.config.defaultCooldownMs = num;
            this.updateMainList();
        });
      }
    } else if (this.view === "groups") {
      if (value === "__back__") {
        this.handleBack(tui);
      } else if (value === "__add__") {
        this.showInput("Group Name", "", (val) => {
            if (val && !this.config.groups[val]) {
                this.config.groups[val] = { name: val, entries: [] };
                this.updateGroupsList();
            }
        });
      } else {
        this.updateGroupEntriesList(value);
        this.selectedIndex = 0;
      }
    } else if (this.view === "group-entries") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else if (value === "__rename__") {
            const oldName = this.currentGroup!;
            this.showInput("Rename Group", oldName, (newName) => {
                if (newName && newName !== oldName && !this.config.groups[newName]) {
                    this.config.groups[newName] = this.config.groups[oldName];
                    delete this.config.groups[oldName];
                    if (this.config.defaultGroup === oldName) this.config.defaultGroup = newName;
                    if (this.activeGroup === oldName) this.activeGroup = newName;
                    this.updateGroupsList();
                    this.selectedIndex = 0;
                }
            });
        } else if (value === "__delete__") {
            delete this.config.groups[this.currentGroup!];
            this.updateGroupsList();
            this.selectedIndex = 0;
        } else if (value === "__add_entry__") {
            this.showInput("Model ID (e.g. anthropic/claude-3-5-sonnet)", "", (id) => {
                if (id) {
                    this.config.groups[this.currentGroup!].entries.push({ id });
                    this.updateGroupEntriesList(this.currentGroup!);
                }
            });
        } else if (value.startsWith("entry-")) {
            const idx = parseInt(value.split("-")[1]);
            this.updateEntryOptionsList(idx);
            this.selectedIndex = 0;
        }
    } else if (this.view === "entry-options") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else if (value === "cooldown") {
            const entry = this.config.groups[this.currentGroup!].entries[this.currentEntryIdx!];
            this.showInput(`Cooldown for ${entry.id}`, (entry.cooldownMs || "").toString(), (val) => {
                if (val === "0" || val === "") {
                    delete entry.cooldownMs;
                } else {
                    const num = parseInt(val);
                    if (!isNaN(num)) entry.cooldownMs = num;
                }
                this.updateEntryOptionsList(this.currentEntryIdx!);
            });
        } else if (value === "delete") {
            this.config.groups[this.currentGroup!].entries.splice(this.currentEntryIdx!, 1);
            this.updateGroupEntriesList(this.currentGroup!);
            this.selectedIndex = 0;
        }
    } else if (this.view === "credentials") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else if (value === "__sync__") {
            this.onDone({ action: "sync", config: this.config });
        } else if (value === "__add_provider__") {
            this.updateAddProviderTypeList();
            this.selectedIndex = 0;
        } else {
            this.updateProviderCredsList(value);
            this.selectedIndex = 0;
        }
    } else if (this.view === "add-provider-type") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else {
            this.updateSelectProviderList(value as "api_key" | "oauth");
            this.selectedIndex = 0;
        }
    } else if (this.view === "select-provider") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else if (value === "__custom__") {
            this.showInput("Provider ID", "", (pid) => {
                if (pid) {
                    if (!this.config.credentials) this.config.credentials = {};
                    if (!this.config.credentials[pid]) this.config.credentials[pid] = {};
                    this.updateProviderCredsList(pid);
                    this.selectedIndex = 0;
                }
            });
        } else {
            const pid = value;
            if (!this.config.credentials) this.config.credentials = {};
            if (!this.config.credentials[pid]) this.config.credentials[pid] = {};
            this.updateProviderCredsList(pid);
            this.selectedIndex = 0;
        }
    } else if (this.view === "provider-creds") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else if (value === "__add_api_key__") {
            this.showInput("API Key", "", (key) => {
                if (key) {
                    if (!this.config.credentials![this.currentProvider!]) {
                        this.config.credentials![this.currentProvider!] = {};
                    }
                    const stored = this.config.credentials![this.currentProvider!];
                    const name = stored["primary"] ? `backup-${Object.keys(stored).filter(k => k !== "type").length}` : "primary";
                    stored[name] = { key, type: "api_key" };
                    this.updateProviderCredsList(this.currentProvider!);
                }
            });
        } else if (value === "__add_oauth__") {
            this.onDone({ action: "oauth", provider: this.currentProvider, config: this.config });
        } else if (value === "__delete_provider__") {
            delete this.config.credentials![this.currentProvider!];
            this.updateCredentialsList();
            this.selectedIndex = 0;
        } else if (this.config.credentials![this.currentProvider!][value]) {
            this.updateCredentialOptionsList(value);
            this.selectedIndex = 0;
        }
    } else if (this.view === "cred-options") {
        if (value === "__back__") {
            this.handleBack(tui);
        } else if (value === "activate") {
            this.onDone({ action: "activate", provider: this.currentProvider, name: this.currentCredName, config: this.config });
        } else if (value === "delete") {
            delete this.config.credentials![this.currentProvider!][this.currentCredName!];
            this.updateProviderCredsList(this.currentProvider!);
            this.selectedIndex = 0;
        }
    }
    tui.requestRender();
  }

  invalidate() {}
}
