/**
 * Indexed mode: Sourcegraph-backed reverse prompt.
 * POST { repoUrl } -> cited rebuild prompt (spec: GitReverse x Sourcegraph).
 * Requires SOURCEGRAPH_TOKEN (free sourcegraph.com token) for reliable access;
 * anonymous access is attempted and may rate-limit.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseGitHubRepoInput } from "@/lib/parse-github-repo";
import { buildIndexedContext } from "@/lib/indexed-context";
import { SYSTEM_PROMPT_INDEXED } from "@/lib/system-prompt-indexed";

const LLM_URL =
  process.env.GITREVERSE_LLM_BASE_URL?.trim() ||
  "https://openrouter.ai/api/v1/chat/completions";
const LLM_MODEL = process.env.GITREVERSE_LLM_MODEL?.trim() || "google/gemini-2.5-pro";

export async function POST(request: NextRequest) {
  let body: { repoUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseGitHubRepoInput(body.repoUrl ?? "");
  if (!parsed) {
    return NextResponse.json(
      { error: "Could not parse a GitHub repo. Use owner/repo or a full URL." },
      { status: 400 },
    );
  }
  const apiKey =
    process.env.GITREVERSE_LLM_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Indexed mode needs GITREVERSE_LLM_API_KEY (any OpenAI-compatible key) configured." },
      { status: 503 },
    );
  }

  const pack = await buildIndexedContext(parsed.owner, parsed.repo, "explicit");
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT_INDEXED },
        { role: "user", content: pack.contextText },
      ],
    }),
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `LLM provider error: ${res.status}` },
      { status: 502 },
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const prompt = data.choices?.[0]?.message?.content ?? "";
  return NextResponse.json({
    mode: "indexed",
    prompt,
    citations: pack.citations,
    queriesRun: pack.queriesRun,
  });
}
