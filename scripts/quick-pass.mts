/**
 * Quick-pass harness: runs the repo's own Quick pipeline (github-client +
 * file-tree-formatter + system-prompt) end-to-end from the CLI.
 *
 *   GITHUB_TOKEN=... npx tsx scripts/quick-pass.mts owner/repo
 *
 * LLM leg (optional): set GITREVERSE_LLM_BASE_URL / GITREVERSE_LLM_API_KEY /
 * GITREVERSE_LLM_MODEL (any OpenAI-compatible endpoint). Without a key the
 * harness prints the fully assembled context + request and exits 0 with
 * llm_called=false so the pipeline is still verifiable.
 */
import { getFileTree, getReadme, getRepoMeta } from "../lib/github-client";
import { formatAsFilteredTree } from "../lib/file-tree-formatter";
import { SYSTEM_PROMPT } from "../lib/system-prompt";

const arg = process.argv[2] || "";
const [owner, repo] = arg.split("/");
if (!owner || !repo) {
  console.error("usage: npx tsx scripts/quick-pass.mts owner/repo");
  process.exit(1);
}

const meta = await getRepoMeta(owner, repo);
const branch = meta.default_branch;
const tree = await getFileTree(owner, repo, branch);
const readme = await getReadme(owner, repo, branch);

// formatAsFilteredTree signature: (items, maxDepth?) — verify at build time.
const treeItems = (
  (tree as { tree?: Array<{ path: string; type: string }> }).tree ??
  (tree as Array<{ path: string; type: string }>)
) as Array<{ path: string; type: string }>;
const treeText = formatAsFilteredTree(treeItems, repo);

const contextText = [
  `# Repository: ${owner}/${repo}`,
  meta.description ? `Description: ${meta.description}` : "",
  meta.language ? `Language: ${meta.language}` : "",
  meta.topics?.length ? `Topics: ${meta.topics.join(", ")}` : "",
  "",
  "## File tree (root)",
  typeof treeText === "string" ? treeText : JSON.stringify(treeText),
  "",
  "## README",
  (readme ?? "(no README)").slice(0, 8000),
].join("\n");

const apiKey = process.env.GITREVERSE_LLM_API_KEY?.trim();
const baseUrl =
  process.env.GITREVERSE_LLM_BASE_URL?.trim() ||
  "https://openrouter.ai/api/v1/chat/completions";
const model = process.env.GITREVERSE_LLM_MODEL?.trim() || "google/gemini-2.5-pro";

if (!apiKey) {
  console.log(JSON.stringify({
    llm_called: false,
    note: "No GITREVERSE_LLM_API_KEY - context assembly verified; synthesis leg skipped.",
    repo: `${owner}/${repo}`,
    meta,
    context_chars: contextText.length,
    request_preview: { url: baseUrl, model, system_chars: SYSTEM_PROMPT.length },
  }, null, 2));
  console.log("---ASSEMBLED CONTEXT---");
  console.log(contextText.slice(0, 3000));
  process.exit(0);
}

const res = await fetch(baseUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: contextText },
    ],
  }),
});
if (!res.ok) {
  console.error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const data = await res.json();
console.log(JSON.stringify({ llm_called: true, model, repo: `${owner}/${repo}` }));
console.log("---PROMPT---");
console.log(data.choices?.[0]?.message?.content ?? "(empty)");
