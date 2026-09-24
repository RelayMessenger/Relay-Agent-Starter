import { describe, expect, it, vi } from "vitest";

import { readWebpage, webSearch } from "../src/web";

const env = { TAVILY_API_KEY: "tvly-test" };

describe("web search (Tavily)", () => {
  it("searches with the key and trims results", async () => {
    const fetcher = vi.fn(async () => Response.json({
      answer: "The Royal Oak Farmers Market is at 316 E 11 Mile Rd.",
      results: [{ content: "x".repeat(2_000), title: "Farmers Market", url: "https://example.com/market" }],
    }));
    const result = await webSearch(env, { query: "royal oak farmers market address" }, fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ answer: "The Royal Oak Farmers Market is at 316 E 11 Mile Rd.", status: "ok" });
    expect((result.results as Array<{ content: string }>)[0]!.content.length).toBeLessThanOrEqual(701);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tvly-test");
    expect(JSON.parse(String(init.body))).toMatchObject({ include_answer: true, query: "royal oak farmers market address", topic: "general" });
  });

  it("reads one page", async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [{ raw_content: "Hello page", url: "https://example.com" }] }));
    expect(await readWebpage(env, "https://example.com", fetcher as unknown as typeof fetch))
      .toEqual({ content: "Hello page", status: "ok", url: "https://example.com" });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe("https://api.tavily.com/extract");
  });

  it("says so when not configured or failing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await webSearch({}, { query: "x y" })).toMatchObject({ status: "not_configured" });
    const down = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await webSearch(env, { query: "x y" }, down as unknown as typeof fetch)).toMatchObject({ status: "unavailable" });
  });
});
