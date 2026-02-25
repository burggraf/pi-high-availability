    });

    // --- Settings Section ---
    const settingsItems = [
      {
        id: "set-default-group",
        label: `🎯 Default Group: ${this.config.defaultGroup || "None"}`,
        action: () => {
          const names = Object.keys(this.config.groups);
          const current = this.config.defaultGroup || "";
          const nextIdx = (names.indexOf(current) + 1) % names.length;
          this.config.defaultGroup = names[nextIdx];
          this.accordion.setSections(this.buildSections());
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
        { id: "save", label: "💾 Save & Exit", action: () => this.onDone({ action: "save", config: this.config, activeGroup: this.activeGroup }) },
        { id: "cancel", label: "❌ Cancel", action: () => this.onDone(null) }
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
    } else {
      container.addChild(new Text(theme.fg("accent", theme.bold(" High Availability Manager ")), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(this.accordion);
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • space toggle • enter select • esc exit "), 1, 0));
    }

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return container.render(width);
  }

  handleInput(data: string, tui: any): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "input") {
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
    } else {
      this.accordion.handleInput(data);
    }
    tui.requestRender();
  }

  invalidate() {
    this.accordion.invalidate();
  }
}
