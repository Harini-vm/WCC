// Optional: label sentences with Claude using the user's own Anthropic API key.
// The key is used only from this browser tab for these requests and is never stored.
// Every label Claude proposes is still checked: the quote must exist word-for-word, the claim is
// labelled Inferred, and Baton's own second model gives an independent verdict.

import { ML_LABELS } from "./ml.js";

export const LLM_PROMPT = `You label sentences taken from a team project's documents, chats, commits and pull requests, for a knowledge-handover tool.
For each numbered sentence choose exactly one label:
- decision: something was chosen, changed, dropped, fixed or agreed
- risk: something may go wrong, is fragile, unsafe, or worries someone
- dependency: work is blocked by, waiting on, or depends on someone or something
- question: an open question that still needs an answer
- action: a task someone should do or has committed to do
- none: anything else (descriptions, status, thanks, chatter, tutorial or setup steps for a reader)
Reply with ONLY a JSON array, no prose: [{"i":1,"label":"decision"},{"i":2,"label":"none"}]`;

export function buildRequest(sentences, model) {
  return {
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content: `${LLM_PROMPT}\n\nSentences:\n${sentences.map((s, i) => `${i + 1}. ${s.replace(/\s+/g, " ")}`).join("\n")}` }],
  };
}

export function parseLabels(text, n) {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("Claude did not return a JSON list.");
  const arr = JSON.parse(text.slice(a, b + 1));
  const out = new Array(n).fill("none");
  for (const x of arr) {
    const i = Number(x.i) - 1;
    if (i >= 0 && i < n && ML_LABELS.includes(String(x.label))) out[i] = String(x.label);
  }
  return out;
}

/**
 * Label sentences with Claude in batches. Returns an array of labels, same order as input.
 * onProgress(done, total) is called after each batch.
 */
export async function labelWithClaude(sentences, { apiKey, model = "claude-haiku-5-5", batch = 60, fetchImpl = fetch, onProgress = () => {} } = {}) {
  if (!apiKey || !/^sk-ant-/.test(apiKey.trim())) throw new Error("Enter an Anthropic API key (it starts with sk-ant-).");
  const labels = [];
  for (let start = 0; start < sentences.length; start += batch) {
    const chunk = sentences.slice(start, start + batch);
    let r;
    try {
      r = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(buildRequest(chunk, model)),
      });
    } catch {
      throw new Error("Could not reach the Anthropic API from this browser.");
    }
    if (r.status === 401) throw new Error("The API key was rejected.");
    if (r.status === 404) throw new Error(`Model "${model}" was not found for this key.`);
    if (r.status === 429) throw new Error("Rate limited by the Anthropic API. Try again in a minute.");
    if (!r.ok) throw new Error(`Anthropic API returned ${r.status}.`);
    const data = await r.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    labels.push(...parseLabels(text, chunk.length));
    onProgress(Math.min(start + batch, sentences.length), sentences.length);
  }
  return labels;
}
