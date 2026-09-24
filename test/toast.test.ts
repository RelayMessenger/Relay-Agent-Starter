import { afterEach, describe, expect, it, vi } from "vitest";

import type { Menu } from "../src/menu";
import { liveMenu, mapToastMenus, resetToastCache, toastConfigured } from "../src/toast";

const SNAPSHOT: Menu = {
  capturedAt: "2026-09-24T00:00:00Z",
  categories: [
    {
      ageRestricted: false,
      items: [{
        description: null,
        guid: "g-deluxe",
        name: '14" Deluxe Pizza',
        price: 17.99,
        priceText: "$17.99",
        url: "https://taniaspizza.toast.site/order/tanias-pizza/item-14-deluxe-pizza_g-deluxe",
      }],
      name: '14" Large',
    },
    { ageRestricted: true, items: [], name: "Beer 6 Packs" },
  ],
  modifierGroups: [],
  notes: [],
  orderUrl: "https://taniaspizza.toast.site/order",
  schemaVersion: 1,
  source: "snapshot",
};

const CONFIG = {
  TOAST_CLIENT_ID: "id",
  TOAST_CLIENT_SECRET: "secret",
  TOAST_RESTAURANT_GUID: "rest-guid",
};

const TOAST_MENUS = {
  menus: [{
    menuGroups: [
      {
        menuItems: [
          { description: "Pepperoni, ham, sausage", guid: "g-deluxe", modifierGroupReferences: [1], name: '14" Deluxe Pizza', price: 18.49 },
          { guid: "g-new", name: '14" New Pie', price: 19.99 },
        ],
        name: '14" Large',
      },
      { menuItems: [{ guid: "g-ipa", name: "IPA 6 Pack", price: 11.99 }], name: "Beer 6 Packs" },
    ],
  }],
  modifierGroupReferences: {
    1: { maxSelections: 1, minSelections: 1, modifierOptionReferences: [10], name: "Crust", requiredMode: "REQUIRED" },
  },
  modifierOptionReferences: { 10: { name: "Stuffed", price: 2.99 } },
};

afterEach(() => resetToastCache());

describe("Toast menus v2 mapping", () => {
  it("keeps snapshot deep links by GUID and live prices", () => {
    const menu = mapToastMenus(TOAST_MENUS, SNAPSHOT);
    const [large, beer] = menu.categories;
    expect(large!.items[0]).toMatchObject({
      price: 18.49,
      priceText: "$18.49",
      url: SNAPSHOT.categories[0]!.items[0]!.url,
    });
    expect(large!.items[1]!.url).toBeNull();
    expect(beer).toMatchObject({ ageRestricted: true, name: "Beer 6 Packs" });
    expect(menu.modifierGroups).toEqual([{
      appliesTo: '14" Deluxe Pizza',
      max: 1,
      min: 1,
      name: "Crust",
      options: [{ name: "Stuffed", price: 2.99 }],
      required: true,
    }]);
  });
});

describe("live Toast menu", () => {
  it("uses the snapshot when credentials are absent", async () => {
    expect(toastConfigured({})).toBe(false);
    expect(await liveMenu({}, SNAPSHOT)).toBe(SNAPSHOT);
  });

  it("authenticates as a machine client, then reads menus v2 with the restaurant header", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/authentication/v1/authentication/login")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          clientId: "id",
          clientSecret: "secret",
          userAccessType: "TOAST_MACHINE_CLIENT",
        });
        return Response.json({ token: { accessToken: "tok", expiresIn: 3600 } });
      }
      expect(url).toBe("https://ws-api.toasttab.com/menus/v2/menus");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tok");
      expect(headers.get("Toast-Restaurant-External-ID")).toBe("rest-guid");
      return Response.json(TOAST_MENUS);
    });
    const menu = await liveMenu(CONFIG, SNAPSHOT, fetcher as typeof fetch);
    expect(menu.source).toBe("toast-menus-v2");
    await liveMenu(CONFIG, SNAPSHOT, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2); // cached for five minutes
  });

  it("falls back to the snapshot when Toast fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response("no", { status: 401 }));
    expect(await liveMenu(CONFIG, SNAPSHOT, fetcher as typeof fetch)).toBe(SNAPSHOT);
  });
});
