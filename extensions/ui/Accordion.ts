import { Component, Container, Text, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { Theme } from "@mariozechner/pi-coding-agent";

export interface AccordionSection {
  id: string;
  label: string;
  description?: string;
  content: Component;
  items?: { id: string; label: string; action: () => void }[];
}

export class Accordion extends Container {
  private sections: AccordionSection[];
  private expandedIds: Set<string> = new Set();
  private selectedIndex = 0; // Index in the "flat" visible list
  private theme: Theme;
  private onSelect?: (id: string) => void;

  constructor(sections: AccordionSection[], theme: Theme, onSelect?: (id: string) => void) {
    super();
    this.sections = sections;
    this.theme = theme;
    this.onSelect = onSelect;
    this.rebuild();
  }

  public setSections(sections: AccordionSection[]) {
    this.sections = sections;
    this.rebuild();
  }

  private getVisibleItems() {
    const items: { type: "section" | "item"; section: AccordionSection; itemIndex?: number }[] = [];
    this.sections.forEach((section) => {
      items.push({ type: "section", section });
      if (this.expandedIds.has(section.id) && section.items) {
        section.items.forEach((_, i) => {
          items.push({ type: "item", section, itemIndex: i });
        });
      }
    });
    return items;
  }

  private rebuild() {
    this.clear();
    const th = this.theme;
    const visibleItems = this.getVisibleItems();
    
    // Clamp selection
    if (this.selectedIndex >= visibleItems.length) {
      this.selectedIndex = Math.max(0, visibleItems.length - 1);
    }

    visibleItems.forEach((v, index) => {
      const isSelected = index === this.selectedIndex;
      
      if (v.type === "section") {
        const isExpanded = this.expandedIds.has(v.section.id);
        const icon = isExpanded ? "▼" : "▶";
        const selectionMarker = isSelected ? th.fg("accent", "● ") : "  ";
        const label = isSelected ? th.fg("accent", v.section.label) : v.section.label;
        const desc = v.section.description ? th.fg("muted", ` (${v.section.description})`) : "";
        
        this.addChild(new Text(`${selectionMarker}${th.fg("accent", icon)} ${label}${desc}`, 0, 0));
      } else {
        const item = v.section.items![v.itemIndex!];
        const selectionMarker = isSelected ? th.fg("accent", "  ● ") : "    ";
        const label = isSelected ? th.fg("accent", item.label) : th.fg("text", item.label);
        this.addChild(new Text(`${selectionMarker}${label}`, 0, 0));
      }
    });
  }

  handleInput(data: string): void {
    const visibleItems = this.getVisibleItems();

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.rebuild();
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(visibleItems.length - 1, this.selectedIndex + 1);
      this.rebuild();
    } else if (matchesKey(data, Key.space) || matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
      const v = visibleItems[this.selectedIndex];
      if (v.type === "section") {
        if (this.expandedIds.has(v.section.id)) {
          this.expandedIds.delete(v.section.id);
        } else {
          this.expandedIds.add(v.section.id);
        }
        this.rebuild();
      } else {
        // Allow space to toggle items too if they are just triggers
        const item = v.section.items![v.itemIndex!];
        item.action();
        this.rebuild();
      }
    } else if (matchesKey(data, Key.enter)) {
      const v = visibleItems[this.selectedIndex];
      if (v.type === "section") {
        this.onSelect?.(v.section.id);
      } else {
        const item = v.section.items![v.itemIndex!];
        item.action();
        this.rebuild(); // Refresh UI in case action changed labels
      }
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }
}
