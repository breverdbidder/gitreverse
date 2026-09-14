/**
 * Sourcegraph client — Indexed-mode context engine (free tier / OSS path).
 *
 * Env:
 *   SOURCEGRAPH_URL    default "https://sourcegraph.com" (free tier covers public OSS code)
 *   SOURCEGRAPH_TOKEN  access token from a free Sourcegraph.com account; when absent we
 *                      attempt anonymous access (rate-limited) rather than failing closed.
 *
 * Uses the streaming search REST endpoint (Sourcegraph 7.0+ / sourcegraph.com),
 * NOT GraphQL (debug-only upstream). No paid plan required.
 */

export interface SourcegraphConfig {
  baseUrl: string;
  token: string | null;
}

export interface CitedSnippet {
  repo: string;
  path: string;
  line: number;
  content: string;
}

export function getSourcegraphConfig(): SourcegraphConfig | { error: string } {
  const baseUrl = (
    process.env.SOURCEGRAPH_URL?.trim() || "https://sourcegraph.com"
  ).replace(/\/+$/, "");
  const token = process.env.SOURCEGRAPH_TOKEN?.trim() || null;
  return { baseUrl, token };
}

function headers(token: string | null): HeadersInit {
  const h: Record<string, string> = { Accept: "text/event-stream" };
  if (token) h["Authorization"] = `token ${token}`;
  return h;
}

/** One streaming search query. Returns cited content/file matches, capped. */
export async function searchSnippets(
  cfg: SourcegraphConfig,
  query: string,
  maxMatches = 12,
): Promise<CitedSnippet[]> {
  const url = `${cfg.baseUrl}/.api/search/stream?${new URLSearchParams({
    q: query,
    v: "V3",
    t: "literal",
    display: "20",
  })}`;
  const res = await fetch(url, { headers: headers(cfg.token) });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Sourcegraph auth required: set SOURCEGRAPH_TOKEN (free sourcegraph.com account token).",
    );
  }
  if (!res.ok) {
    throw new Error(`Sourcegraph search error: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const snippets: CitedSnippet[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let events: unknown;
    try {
      events = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (!Array.isArray(events)) continue;
    for (const ev of events as Array<Record<string, unknown>>) {
      if (ev?.type === "content" && Array.isArray(ev.lineMatches)) {
        const repo = String(ev.repository ?? "").replace(/^github\.com\//, "");
        const path = String(ev.path ?? "");
        for (const lm of ev.lineMatches as Array<Record<string, unknown>>) {
          snippets.push({
            repo,
            path,
            line: Number(lm.lineNumber ?? 0) + 1,
            content: String(lm.line ?? "").slice(0, 400),
          });
          if (snippets.length >= maxMatches) return snippets;
        }
      } else if (ev?.type === "path") {
        snippets.push({
          repo: String(ev.repository ?? "").replace(/^github\.com\//, ""),
          path: String(ev.path ?? ""),
          line: 0,
          content: "",
        });
        if (snippets.length >= maxMatches) return snippets;
      }
    }
  }
  return snippets;
}

/** Raw file read via the Sourcegraph raw endpoint (works for public repos). */
export async function readFile(
  cfg: SourcegraphConfig,
  repo: string,
  path: string,
  maxChars = 12000,
): Promise<string | null> {
  const url = `${cfg.baseUrl}/github.com/${repo}@HEAD/-/raw/${path}`;
  const h: Record<string, string> = {};
  if (cfg.token) h["Authorization"] = `token ${cfg.token}`;
  const res = await fetch(url, { headers: h });
  if (!res.ok) return null;
  const text = await res.text();
  return text.slice(0, maxChars);
}
