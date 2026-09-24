import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { availabilityInput, cateringAvailability, type CateringConfiguration } from "./catering";
import { storeStatus, weeklyHoursText } from "./hours";
import { deliveryDistanceToAddress } from "./geocode";
import type { DeliveryDistance } from "./interactive";
import {
  categoryItems,
  itemOptions,
  menuCategories,
  offeredChoice,
  orderUrl,
  searchMenu,
  type Menu,
} from "./menu";

export interface ToolDependencies {
  /** Distance from the shop to the customer's shared location. */
  deliveryDistance?: () => Promise<DeliveryDistance>;
  env: CateringConfiguration;
  menu(): Promise<Menu>;
  now(): Date;
  fetcher?: typeof fetch;
}

/** Read-only tools. Side effects (reply, request_catering) are Think Actions. */
export function taniasTools(deps: ToolDependencies): ToolSet {
  return {
    search_menu: tool({
      description:
        "Search Tania's menu. Pass every item the customer mentioned in one call, one query per item "
        + '(e.g. ["14 inch pepperoni", "medium veggie", "bone-in wings"]). Returns matching items with price '
        + "and the orderLink to send the customer.",
      inputSchema: z.object({
        queries: z.array(z.string().trim().min(1).max(200)).min(1).max(12)
          .describe("One search per item, size or ingredient the customer asked about"),
      }).strict(),
      execute: async ({ queries }) => {
        const menu = await deps.menu();
        // Fewer matches per query as the list grows keeps the tool result small.
        const perQuery = queries.length > 3 ? 4 : 8;
        const results = queries.map((query) => {
          const matches = searchMenu(menu, query, perQuery);
          return matches.length > 0
            ? { matches, query }
            : { matches: [], note: "No match. Try other words or list categories.", query };
        });
        return { orderPage: orderUrl(menu), results };
      },
    }),
    list_menu_categories: tool({
      description: "List menu categories, or the items in one category when category is given.",
      inputSchema: z.object({
        category: z.string().trim().max(100).optional(),
      }).strict(),
      execute: async ({ category }) => {
        const menu = await deps.menu();
        return category
          ? { category, items: categoryItems(menu, category) }
          : { categories: menuCategories(menu) };
      },
    }),
    get_item_options: tool({
      description:
        "Customization choices for an item (crust, sauce, cheese, toppings, extras) with add-on prices, as on the order "
        + "page. Each choice comes ready to send: pass its buttons or selection straight into reply's buttons or "
        + "selection field, with its question in your text. Pass every item you need in one call.",
      inputSchema: z.object({
        items: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
      }).strict(),
      execute: async ({ items }) => {
        const menu = await deps.menu();
        return {
          results: items.map((item) => {
            const options = itemOptions(menu, item);
            return options
              ? {
                choices: options.groups.map(offeredChoice).filter((choice) => choice !== null),
                item: options.item,
              }
              : { choices: [], item, note: "No option details for this item. The order page shows all choices." };
          }),
        };
      },
    }),
    get_store_status: tool({
      description: "Whether Tania's is open right now, and the weekly hours.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({ ...storeStatus(deps.now()), weeklyHours: weeklyHoursText() }),
    }),
    check_delivery_address: tool({
      description:
        "Look up a street address the customer gave and measure its distance from Tania's, and whether it's inside the "
        + "delivery area. Use this whenever they give an address (for an order or catering). Include the city or ZIP.",
      inputSchema: z.object({
        address: z.string().trim().min(5).max(300).describe("The full address as the customer gave it"),
      }).strict(),
      execute: async ({ address }) => deliveryDistanceToAddress(address, deps.fetcher),
    }),
    check_delivery_distance: tool({
      description:
        "Distance from Tania's to the live location the customer is sharing from their phone. Only after they share "
        + "(a location card arrives). For a typed address use check_delivery_address instead.",
      inputSchema: z.object({}).strict(),
      execute: async () => deps.deliveryDistance
        ? deps.deliveryDistance()
        : { instruction: "Location isn't available here. Say checkout confirms the address.", status: "not_sharing" },
    }),
    check_catering_availability: tool({
      description:
        "Open catering start times between two dates (store local). Only offer times this returns.",
      inputSchema: availabilityInput,
      execute: async (input) => cateringAvailability(deps.env, input, deps.fetcher),
    }),
  };
}
