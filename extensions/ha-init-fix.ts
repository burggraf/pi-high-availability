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
      
      
      config = loadConfig();
      if (config?.defaultGroup) {
        state.activeGroup = config.defaultGroup;
      }
      
      ctx.ui.notify(`Created ~/.pi/agent/ha.json with ${entries.length} provider(s). Run /ha-sync to sync credentials.`, "info");
    },
  });
