/**
 * Tania's Pizza facts the agent may state. Every value here is sourced:
 * hours are the owner-confirmed Google Business Profile hours (2026-09-24);
 * the delivery radius is owner-confirmed; the rest comes from
 * taniaspizza.com and Tania's Toast pages. Change this file, not the prompt,
 * when a fact changes.
 */

export const TIME_ZONE = "America/Detroit";

/** 0 = Sunday. Times are 24-hour local "HH:MM". */
export const WEEKLY_HOURS: Readonly<Record<number, { open: string; close: string }>> = {
  0: { open: "11:00", close: "20:00" },
  1: { open: "10:00", close: "20:00" },
  2: { open: "10:00", close: "20:00" },
  3: { open: "10:00", close: "20:00" },
  4: { open: "10:00", close: "20:00" },
  5: { open: "10:00", close: "21:00" },
  6: { open: "10:00", close: "21:00" },
};

export const BUSINESS = {
  name: "Tania's Pizza",
  tagline: "Home of the Stuffed Pizza, since 1987",
  address: "3204 Crooks Rd, Royal Oak, MI 48073",
  phone: "(248) 288-4774",
  website: "https://www.taniaspizza.com",
  orderUrl: "https://taniaspizza.toast.site/order",
  giftCardUrl: "https://order.toasttab.com/egiftcards/tanias-pizza",
  rewardsUrl: "https://www.toasttab.com/tanias-pizza/rewardsSignup",
  deliveryRadiusMiles: 3,
  deliveryApps: ["DoorDash", "Uber Eats", "Grubhub"],
} as const;
