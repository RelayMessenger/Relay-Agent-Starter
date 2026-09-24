import type { Menu, MenuCategory, ModifierGroup } from "./menu";

/**
 * Optional live menu from Toast "Standard API access", the restaurant's own
 * read-only credentials (Toast Web > Integrations > Toast API access; needs
 * the menus:read scope). Toast documents Standard API access as GET-only and
 * menus v2 only: https://doc.toasttab.com/doc/devguide/devApiAccessUserGuide.html
 *
 * When the credentials are absent or Toast fails, the agent uses the bundled
 * snapshot. Item deep links are not in the menus API, so they are carried
 * over from the snapshot by item GUID, falling back to the ordering page.
 */

export interface ToastConfiguration {
  TOAST_API_HOSTNAME?: string;
  TOAST_CLIENT_ID?: string;
  TOAST_CLIENT_SECRET?: string;
  TOAST_RESTAURANT_GUID?: string;
}

const DEFAULT_HOSTNAME = "https://ws-api.toasttab.com";
const MENU_TTL_MS = 5 * 60_000;

interface ToastMenusV2 {
  menus?: Array<{ name?: string; menuGroups?: ToastGroup[] }>;
  modifierGroupReferences?: Record<string, ToastModifierGroup>;
  modifierOptionReferences?: Record<string, { name?: string; price?: number | null }>;
}

interface ToastGroup {
  name?: string;
  menuItems?: ToastItem[];
  menuGroups?: ToastGroup[];
}

interface ToastItem {
  name?: string;
  guid?: string;
  description?: string | null;
  price?: number | null;
  modifierGroupReferences?: number[];
}

interface ToastModifierGroup {
  name?: string;
  minSelections?: number | null;
  maxSelections?: number | null;
  requiredMode?: string | null;
  modifierOptionReferences?: number[];
}

let cached: { expires: number; key: string; menu: Menu } | undefined;
let cachedToken: { expires: number; key: string; token: string } | undefined;

export function toastConfigured(env: ToastConfiguration): boolean {
  return Boolean(
    env.TOAST_CLIENT_ID?.trim()
    && env.TOAST_CLIENT_SECRET?.trim()
    && env.TOAST_RESTAURANT_GUID?.trim(),
  );
}

async function accessToken(env: Required<ToastConfiguration>, fetcher: typeof fetch): Promise<string> {
  const key = `${env.TOAST_API_HOSTNAME}:${env.TOAST_CLIENT_ID}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expires > Date.now()) {
    return cachedToken.token;
  }
  const response = await fetcher(
    `${env.TOAST_API_HOSTNAME}/authentication/v1/authentication/login`,
    {
      body: JSON.stringify({
        clientId: env.TOAST_CLIENT_ID,
        clientSecret: env.TOAST_CLIENT_SECRET,
        userAccessType: "TOAST_MACHINE_CLIENT",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) throw new Error(`Toast authentication failed: ${response.status}`);
  const body = await response.json<{
    token?: { accessToken?: string; expiresIn?: number };
  }>();
  const token = body.token?.accessToken;
  if (!token) throw new Error("Toast authentication returned no access token");
  const lifetimeMs = Math.max(60, (body.token?.expiresIn ?? 3600) - 60) * 1000;
  cachedToken = { expires: Date.now() + lifetimeMs, key, token };
  return token;
}

export function mapToastMenus(raw: ToastMenusV2, snapshot: Menu): Menu {
  const urlByGuid = new Map<string, string>();
  for (const category of snapshot.categories) {
    for (const item of category.items) {
      if (item.guid && item.url) urlByGuid.set(item.guid, item.url);
    }
  }
  const restrictedNames = new Set(
    snapshot.categories.filter((c) => c.ageRestricted).map((c) => c.name.toLowerCase()),
  );
  const categories: MenuCategory[] = [];
  const modifierGroups: ModifierGroup[] = [];
  const optionRefs = raw.modifierOptionReferences ?? {};
  const groupRefs = raw.modifierGroupReferences ?? {};

  const visit = (group: ToastGroup) => {
    const name = group.name?.trim() || "Menu";
    const items = (group.menuItems ?? []).map((item) => {
      for (const reference of item.modifierGroupReferences ?? []) {
        const modifier = groupRefs[String(reference)];
        if (!modifier) continue;
        modifierGroups.push({
          appliesTo: item.name ?? "",
          max: modifier.maxSelections ?? null,
          min: modifier.minSelections ?? null,
          name: modifier.name ?? "Options",
          options: (modifier.modifierOptionReferences ?? []).map((id) => ({
            name: optionRefs[String(id)]?.name ?? "",
            price: optionRefs[String(id)]?.price ?? null,
          })),
          required: modifier.requiredMode ? modifier.requiredMode === "REQUIRED" : null,
        });
      }
      return {
        description: item.description ?? null,
        guid: item.guid ?? null,
        name: item.name ?? "",
        price: item.price ?? null,
        priceText: typeof item.price === "number" ? `$${item.price.toFixed(2)}` : null,
        url: (item.guid && urlByGuid.get(item.guid)) || null,
      };
    });
    if (items.length > 0) {
      categories.push({
        ageRestricted: restrictedNames.has(name.toLowerCase())
          || /\b(beer|wine|liquor|spirits|tobacco|vape|cigar)/iu.test(name),
        items,
        name,
      });
    }
    for (const child of group.menuGroups ?? []) visit(child);
  };
  for (const menu of raw.menus ?? []) {
    for (const group of menu.menuGroups ?? []) visit(group);
  }
  return {
    ...snapshot,
    capturedAt: new Date().toISOString(),
    categories,
    modifierGroups,
    source: "toast-menus-v2",
  };
}

export async function liveMenu(
  env: ToastConfiguration,
  snapshot: Menu,
  fetcher: typeof fetch = fetch,
): Promise<Menu> {
  if (!toastConfigured(env)) return snapshot;
  const config: Required<ToastConfiguration> = {
    TOAST_API_HOSTNAME: env.TOAST_API_HOSTNAME?.trim() || DEFAULT_HOSTNAME,
    TOAST_CLIENT_ID: env.TOAST_CLIENT_ID!.trim(),
    TOAST_CLIENT_SECRET: env.TOAST_CLIENT_SECRET!.trim(),
    TOAST_RESTAURANT_GUID: env.TOAST_RESTAURANT_GUID!.trim(),
  };
  const key = `${config.TOAST_API_HOSTNAME}:${config.TOAST_RESTAURANT_GUID}`;
  if (cached && cached.key === key && cached.expires > Date.now()) return cached.menu;
  try {
    const token = await accessToken(config, fetcher);
    const response = await fetcher(`${config.TOAST_API_HOSTNAME}/menus/v2/menus`, {
      headers: {
        authorization: `Bearer ${token}`,
        "Toast-Restaurant-External-ID": config.TOAST_RESTAURANT_GUID,
      },
    });
    if (!response.ok) throw new Error(`Toast menus failed: ${response.status}`);
    const menu = mapToastMenus(await response.json<ToastMenusV2>(), snapshot);
    if (menu.categories.length === 0) throw new Error("Toast returned an empty menu");
    cached = { expires: Date.now() + MENU_TTL_MS, key, menu };
    return menu;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "toast_menu_fallback",
      error: error instanceof Error ? error.message : String(error),
    }));
    return snapshot;
  }
}

/** Test seam: forget cached Toast tokens and menus. */
export function resetToastCache(): void {
  cached = undefined;
  cachedToken = undefined;
}
