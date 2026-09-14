/**
 * Indexed-mode context packer (GitReverse x Sourcegraph spec).
 *
 * Fixed query pack so every repo gets the same skeleton:
 *   1. Manifests   2. Entrypoints   3. README/docs   4. Exported symbols
 *   5. Tests       6. Recent diffs on the core module
 * Results are deduped, token-capped, and carry repo/path:line citations so the
 * next agent can verify instead of hallucinating.
 */

import {
  getSourcegraphConfig,
  readFile,
  searchSnippets,
  type CitedSnippet,
} from "@/lib/sourcegraph-client";

export interface IndexedContextPack {
  contextText: string;
  citations: CitedSnippet[];
  queriesRun: string[];
  upgradedFrom: "explicit" | "auto";
}

const CONTEXT_CHAR_CAP = 24000; // ~6k tokens

const QUERY_PACK = (repo: string) => [
  `repo:^github\\.com/${repo}$ file:^(package\\.json|go\\.mod|Cargo\\.toml|pyproject\\.toml|Gemfile)$`,
  `repo:^github\\.com/${repo}$ file:^(README|readme)`,
  `repo:^github\\.com/${repo}$ file:^(src/|cmd/|app/|lib/) file:(main\\.|index\\.|app\\.|mod\\.)`,
  `repo:^github\\.com/${repo}$ type:symbol patternType:keyword export`,
  `repo:^github\\.com/${repo}$ file:(test/|_test\\.|spec\\.|__tests__/)`,
  `repo:^github\\.com/${repo}$ type:diff count:10`,
];

/** Heuristic from the spec: auto-upgrade Quick -> Indexed when the cheap pass is thin. */
export function shouldAutoUpgrade(readme: string | null, treeTruncated: boolean, treeEntries: number): boolean {
  if (treeTruncated) return true;
  if (treeEntries > 400) return true;
  if (!readme || readme.trim().length < 500) return true;
  return false;
}

export async function buildIndexedContext(
  owner: string,
  repo: string,
  upgradedFrom: "explicit" | "auto",
): Promise<IndexedContextPack> {
  const cfg = getSourcegraphConfig();
  if ("error" in cfg) throw new Error(cfg.error);
  const full = `${owner}/${repo}`;
  const citations: CitedSnippet[] = [];
  const queriesRun: string[] = [];
  const sections: string[] = [];
  let used = 0;

  for (const q of QUERY_PACK(full)) {
    queriesRun.push(q);
    try {
      const hits = await searchSnippets(cfg, q, 12);
      for (const h of hits) {
        if (used >= CONTEXT_CHAR_CAP) break;
        citations.push(h);
        const line = h.content
          ? `- ${h.repo}/${h.path}:${h.line}  ${h.content.trim()}`
          : `- ${h.repo}/${h.path}`;
        sections.push(line);
        used += line.length;
      }
    } catch (e) {
      sections.push(`- [query failed: ${q}] ${e instanceof Error ? e.message : String(e)}`);
    }
    if (used >= CONTEXT_CHAR_CAP) break;
  }

  // README + primary manifest in full (bounded), cited.
  for (const path of ["README.md", "package.json", "go.mod", "pyproject.toml"]) {
    if (used >= CONTEXT_CHAR_CAP) break;
    const content = await readFile(cfg, full, path, 8000);
    if (content) {
      citations.push({ repo: full, path, line: 1, content: "(full file excerpt)" });
      const block = `\n## ${full}/${path}\n${content.slice(0, Math.min(8000, CONTEXT_CHAR_CAP - used))}\n`;
      sections.push(block);
      used += block.length;
    }
  }

  const contextText = [
    `# Indexed context pack for ${full}`,
    `Engine: Sourcegraph (${cfg.baseUrl}) - search + file reads, cited.`,
    `Upgrade path: ${upgradedFrom}`,
    "",
    "## Cited hits (repo/path:line)",
    ...sections,
  ].join("\n");

  return { contextText, citations, queriesRun, upgradedFrom };
}
