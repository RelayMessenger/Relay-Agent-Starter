import { describe, expect, it } from "vitest";

import {
  categoryItems,
  itemOptions,
  menuCategories,
  searchMenu,
  SNAPSHOT_MENU,
  tokenize,
  type Menu,
} from "../src/menu";

const ORDER = "https://taniaspizza.toast.site/order";
const item = (name: string, price: number, slug: string) => ({
  description: null,
  guid: slug,
  name,
  price,
  priceText: `$${price.toFixed(2)}`,
  url: `${ORDER}/tanias-pizza/item-${slug}`,
});

const FIXTURE: Menu = {
  capturedAt: "2026-09-24T00:00:00Z",
  categories: [
    {
      ageRestricted: false,
      items: [item('14" Deluxe Pizza', 17.99, "14-deluxe"), item('14" Veggie Pizza', 17.99, "14-veggie")],
      name: '14" Large',
    },
    {
      ageRestricted: false,
      items: [item('10" Deluxe Pizza', 11.99, "10-deluxe")],
      name: '10" Small',
    },
    {
      ageRestricted: false,
      items: [{ ...item("Garlic Bread Bites", 2.99, "garlic"), url: null }],
      name: "Bread",
    },
    {
      ageRestricted: true,
      items: [item("Deluxe Lager 6 Pack", 12.99, "lager")],
      name: "Beer 6 Packs",
    },
  ],
  modifierGroups: [{
    appliesTo: '14" Build Your Own Pizza',
    max: 1,
    min: 1,
    name: "Crust",
    options: [{ name: "Stuffed", price: 2.99 }],
    required: true,
  }],
  notes: [],
  orderUrl: ORDER,
  schemaVersion: 1,
  source: ORDER,
};

describe("tokenize", () => {
  it("normalizes sizes and plurals", () => {
    expect(tokenize('14" pizzas')).toEqual(["14in", "pizza"]);
    expect(tokenize("14 inch Deluxe")).toEqual(["14in", "deluxe"]);
    expect(tokenize("Tania's")).toEqual(tokenize("Tanias"));
  });
});

describe("menu search", () => {
  it("ranks size matches first and returns item links", () => {
    const [first] = searchMenu(FIXTURE, "large 14 inch deluxe");
    expect(first).toMatchObject({
      name: '14" Deluxe Pizza',
      orderLink: `${ORDER}/tanias-pizza/item-14-deluxe`,
      price: "$17.99",
    });
  });

  it("never returns age-restricted items", () => {
    const names = searchMenu(FIXTURE, "deluxe lager beer").map((m) => m.name);
    expect(names).not.toContain("Deluxe Lager 6 Pack");
    expect(menuCategories(FIXTURE).map((c) => c.name)).not.toContain("Beer 6 Packs");
    expect(categoryItems(FIXTURE, "Beer 6 Packs")).toEqual([]);
  });

  it("falls back to the order page when an item has no link", () => {
    expect(searchMenu(FIXTURE, "garlic bread")[0]?.orderLink).toBe(ORDER);
  });

  it("returns nothing for an empty query", () => {
    expect(searchMenu(FIXTURE, "   ")).toEqual([]);
  });

  it("finds modifier groups for an item family", () => {
    expect(itemOptions(FIXTURE, "14 inch build your own")).toMatchObject({
      groups: [{ name: "Crust" }],
      item: '14" Build Your Own Pizza',
    });
    expect(itemOptions(FIXTURE, "zzz")).toBeNull();
  });
});

describe("bundled Toast snapshot", () => {
  const menu = SNAPSHOT_MENU;
  const sellable = menu.categories.filter((c) => !c.ageRestricted).flatMap((c) => c.items);

  it("is schema version 1 from Tania's Toast page", () => {
    expect(menu.schemaVersion).toBe(1);
    expect(menu.orderUrl).toBe(ORDER);
    expect(sellable.length).toBeGreaterThan(50);
  });

  it("links every item only to Tania's Toast ordering site", () => {
    for (const entry of menu.categories.flatMap((c) => c.items)) {
      if (entry.url !== null) {
        expect(entry.url.startsWith(`${ORDER}/tanias-pizza/item-`)).toBe(true);
      }
      expect(entry.price === null || Number.isFinite(entry.price)).toBe(true);
    }
  });

  it("marks alcohol categories as age-restricted", () => {
    for (const category of menu.categories) {
      if (/beer|wine|seltzer|cider|tall boys/iu.test(category.name)) {
        expect(category.ageRestricted, category.name).toBe(true);
      }
    }
  });

  it("returns the right item's options, including per-size topping prices", () => {
    const large = itemOptions(menu, "14 inch build your own pizza");
    expect(large?.item).toBe('14" Build Your Own Pizza');
    expect(large!.groups.length).toBeGreaterThan(0);
    expect(itemOptions(menu, "12 inch build your own pizza")?.item).toBe('12" Build Your Own Pizza');
  });

  it("finds the signature pizzas with prices and links", () => {
    for (const query of ["14 deluxe", "royal oaker", "build your own 12", "chicken shawarma"]) {
      const [top] = searchMenu(menu, query);
      expect(top, query).toBeDefined();
      expect(top!.price, query).toMatch(/^\$\d+\.\d{2}$/u);
      expect(top!.orderLink.startsWith(ORDER), query).toBe(true);
    }
  });
});
