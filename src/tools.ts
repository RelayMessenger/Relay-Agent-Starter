import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { availabilityInput, cateringAvailability, type CateringConfiguration } from "./catering";
import { storeStatus, weeklyHoursText } from "./hours";
import {
  categoryItems,
  itemOptions,
  menuCategories,
  orderUrl,
  searchMenu,
  type Menu,
} from "./menu";

export interface ToolDependencies {
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
        "Search Tania's menu by keywords (item, size, ingredient, category). Returns matching items with price and the orderLink to send the customer.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
      }).strict(),
      execute: async ({ query }) => {
        const menu = await deps.menu();
        const results = searchMenu(menu, query);
        return results.length > 0
          ? { results, orderPage: orderUrl(menu) }
          : { results: [], orderPage: orderUrl(menu), note: "No match. Try other words or list categories." };
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
        "Customization options for an item (crusts, sizes, sauces, cheese, toppings) with add-on prices, as shown on the order page.",
      inputSchema: z.object({
        item: z.string().trim().min(1).max(200),
      }).strict(),
      execute: async ({ item }) => {
        const options = itemOptions(await deps.menu(), item);
        return options
          ? { item: options.item, optionGroups: options.groups }
          : { item, optionGroups: [], note: "No option details for this item. The order page shows all choices." };
      },
    }),
    get_store_status: tool({
      description: "Whether Tania's is open right now, and the weekly hours.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({ ...storeStatus(deps.now()), weeklyHours: weeklyHoursText() }),
    }),
    check_catering_availability: tool({
      description:
        "Open catering start times between two dates (store local). Only offer times this returns.",
      inputSchema: availabilityInput,
      execute: async (input) => cateringAvailability(deps.env, input, deps.fetcher),
    }),
  };
}
