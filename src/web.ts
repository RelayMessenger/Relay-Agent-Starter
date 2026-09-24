/**
 * Web search and page reading through Tavily (docs.tavily.com: POST /search,
 * POST /extract, Bearer API key). Results are trimmed so a few of them fit in
 * a turn without crowding out the conversation.
 */
const TAVILY = "https://api.tavily.com";
const RESULT_CHARS = 700;
const PAGE_CHARS = 6_000;

export interface WebConfiguration {
  TAVILY_API_KEY?: string;
}

export function webConfigured(env: WebConfiguration): boolean {
  return Boolean(env.TAVILY_API_KEY?.trim());
}

const NOT_CONFIGURED = {
  instruction: "Web search isn't set up. Answer from what you know, or give the shop's phone number.",
  status: "not_configured",
} as const;

async function tavily(env: WebConfiguration, path: string, body: unknown, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(`${TAVILY}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${env.TAVILY_API_KEY!.trim()}`,
      "content-type": "application/json",
    },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Tavily ${path} failed: ${response.status}`);
  return response.json<Record<string, unknown>>();
}

function clip(text: unknown, max: number): string {
  const value = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export interface WebSearchInput {
  query: string;
  topic?: "general" | "news";
  maxResults?: number;
}

export async function webSearch(
  env: WebConfiguration,
  input: WebSearchInput,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!webConfigured(env)) return NOT_CONFIGURED;
  try {
    const body = await tavily(env, "/search", {
      include_answer: true,
      max_results: Math.min(Math.max(input.maxResults ?? 5, 1), 8),
      query: input.query,
      search_depth: "basic",
      topic: input.topic ?? "general",
    }, fetcher, signal);
    const results = Array.isArray(body.results) ? body.results as Array<Record<string, unknown>> : [];
    return {
      answer: clip(body.answer, 800) || null,
      note: "Web results can be wrong or out of date. Tania's own facts (menu, prices, hours) come from your tools, not the web.",
      results: results.map((result) => ({
        content: clip(result.content, RESULT_CHARS),
        title: clip(result.title, 200),
        url: typeof result.url === "string" ? result.url : null,
      })),
      status: "ok",
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: "web_search_failed", error: error instanceof Error ? error.message : String(error) }));
    return { instruction: "Web search failed just now. Say you couldn't look it up.", status: "unavailable" };
  }
}

export async function readWebpage(
  env: WebConfiguration,
  url: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!webConfigured(env)) return NOT_CONFIGURED;
  try {
    const body = await tavily(env, "/extract", { urls: [url] }, fetcher, signal);
    const page = (Array.isArray(body.results) ? body.results[0] : undefined) as Record<string, unknown> | undefined;
    if (!page) return { instruction: "That page couldn't be read.", status: "unreadable", url };
    return { content: clip(page.raw_content, PAGE_CHARS), status: "ok", url: page.url ?? url };
  } catch (error) {
    console.warn(JSON.stringify({ event: "read_webpage_failed", error: error instanceof Error ? error.message : String(error) }));
    return { instruction: "That page couldn't be read just now.", status: "unavailable", url };
  }
}
