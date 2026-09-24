import snapshot from "../data/menu.snapshot.json";

import { BUSINESS } from "./business";

export interface MenuItem {
  name: string;
  description: string | null;
  price: number | null;
  priceText: string | null;
  url: string | null;
  guid: string | null;
  outOfStock?: boolean | null;
}

export interface MenuCategory {
  name: string;
  ageRestricted: boolean;
  items: MenuItem[];
}

export interface ModifierGroup {
  appliesTo: string;
  name: string;
  required: boolean | null;
  min: number | null;
  max: number | null;
  options: Array<{ name: string; price: number | null }>;
}

export interface Menu {
  schemaVersion: number;
  capturedAt: string;
  source: string;
  orderUrl: string;
  categories: MenuCategory[];
  modifierGroups: ModifierGroup[];
  notes: string[];
}

export interface MenuMatch {
  name: string;
  category: string;
  description: string | null;
  price: string | null;
  orderLink: string;
}

export const SNAPSHOT_MENU = snapshot as unknown as Menu;

/** Tokens: lowercase words; 10", 10 in, 10-inch all become "10in". */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d+)\s*(?:"|”|''|-?\s*inch(?:es)?\b|\s?in\b)/gu, "$1in ")
    .replace(/[’']/gu, "")
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)
    .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

function score(queryTokens: string[], item: MenuItem, category: MenuCategory): number {
  const name = new Set(tokenize(item.name));
  const cat = new Set(tokenize(category.name));
  const description = new Set(tokenize(item.description ?? ""));
  let total = 0;
  for (const token of queryTokens) {
    if (name.has(token)) total += 3;
    else if (cat.has(token)) total += 2;
    else if (description.has(token)) total += 1;
  }
  return total;
}

export function toMatch(item: MenuItem, category: MenuCategory, orderUrl: string): MenuMatch {
  return {
    category: category.name,
    description: item.description,
    name: item.name,
    orderLink: item.url ?? orderUrl,
    // Stock is not reported: a snapshot's sold-out flags go stale within
    // hours. The Toast page shows live availability at checkout.
    price: item.priceText ?? (item.price === null ? null : `$${item.price.toFixed(2)}`),
  };
}

/**
 * Keyword search over orderable, non-age-restricted items. The agent never
 * sells alcohol or tobacco: those categories are invisible to it.
 */
export function searchMenu(menu: Menu, query: string, limit = 8): MenuMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const ranked: Array<{ match: MenuMatch; score: number; order: number }> = [];
  let order = 0;
  for (const category of menu.categories) {
    if (category.ageRestricted) continue;
    for (const item of category.items) {
      const value = score(queryTokens, item, category);
      if (value > 0) {
        ranked.push({ match: toMatch(item, category, menu.orderUrl), order: order++, score: value });
      }
    }
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ match }) => match);
}

export function menuCategories(menu: Menu): Array<{ name: string; itemCount: number }> {
  return menu.categories
    .filter((category) => !category.ageRestricted && category.items.length > 0)
    .map((category) => ({ itemCount: category.items.length, name: category.name }));
}

export function categoryItems(menu: Menu, categoryName: string, limit = 25): MenuMatch[] {
  const wanted = tokenize(categoryName).join(" ");
  const category = menu.categories.find(
    (candidate) => !candidate.ageRestricted && tokenize(candidate.name).join(" ") === wanted,
  ) ?? menu.categories.find(
    (candidate) => !candidate.ageRestricted
      && tokenize(candidate.name).join(" ").includes(wanted),
  );
  if (!category) return [];
  return category.items.slice(0, limit).map((item) => toMatch(item, category, menu.orderUrl));
}

/**
 * Modifier groups (crusts, toppings, sauces, ...) for the one item that best
 * matches the name, e.g. "14 inch build your own" -> 14" Build Your Own Pizza.
 */
export function itemOptions(menu: Menu, itemName: string): { item: string; groups: ModifierGroup[] } | null {
  const wanted = new Set(tokenize(itemName));
  let best: { name: string; overlap: number; length: number } | null = null;
  for (const group of menu.modifierGroups) {
    const tokens = tokenize(group.appliesTo);
    const overlap = tokens.filter((token) => wanted.has(token)).length;
    if (overlap === 0) continue;
    if (!best || overlap > best.overlap || (overlap === best.overlap && tokens.length < best.length)) {
      best = { length: tokens.length, name: group.appliesTo, overlap };
    }
  }
  if (!best) return null;
  const name = best.name;
  const seen = new Set<string>();
  const groups = menu.modifierGroups.filter((group) => {
    if (group.appliesTo !== name) return false;
    const key = JSON.stringify([group.name, group.options]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { groups: groups.slice(0, 20), item: name };
}

export function orderUrl(menu: Menu): string {
  return menu.orderUrl || BUSINESS.orderUrl;
}

export type OfferedChoice =
  | { question: string; pick: "one"; buttons: Array<{ label: string }> }
  | { question: string; pick: "one" | "several"; selection: Array<{ value: string; label: string }> };

function priceLabel(name: string, price: number | null): string {
  const label = price && price > 0 ? `${name} (+$${price.toFixed(2)})` : name;
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

/** A modifier group as the component the customer should tap: its question, and buttons or a selection. */
export function offeredChoice(group: ModifierGroup): OfferedChoice | null {
  const options = group.options.filter((option) => option.name.trim());
  if (options.length === 0) return null;
  // Toast's own wording ("Choose your 12\" Crust", "... (Optional, selection Not Required)") trimmed to a question.
  const question = group.name.replace(/\s*\(.*?\)\s*/gu, " ").replace(/\s+/gu, " ").trim();
  const single = group.max === 1;
  if (single && options.length <= 5) {
    return { buttons: options.map((option) => ({ label: priceLabel(option.name, option.price) })), pick: "one", question };
  }
  const seen = new Set<string>();
  const selection = options.slice(0, 25).map((option, index) => {
    let value = option.name.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || `option_${index}`;
    if (seen.has(value)) value = `${value}_${index}`;
    seen.add(value);
    return { label: priceLabel(option.name, option.price), value: value.slice(0, 100) };
  });
  return { pick: single ? "one" : "several", question, selection };
}
