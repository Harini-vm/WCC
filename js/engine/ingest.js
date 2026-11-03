// Ingestion: turn raw exports into normalised, permission-tagged, redacted evidence.
// Evidence item:
// { id, source: 'github'|'docs'|'chat'|'testimony', kind, ref, title, text, author,
//   date, visibility: 'team'|'leads'|'private', meta }

import { redact } from "./redact.js";
import { isoDate, sentences } from "./util.js";

export const VISIBILITY = {
  team: "Whole team",
  leads: "Leads only",
  private: "Private (never shared)",
};

function nameOf(login, people) {
  if (!login) return null;
  const p = (people || []).find((x) => x.handle === login || x.name === login);
  return p ? p.name : login;
}

function make(ev, findingsOut) {
  const r = redact(ev.text);
  const t = redact(ev.title || "");
  for (const f of [...r.findings, ...t.findings]) findingsOut.push({ ...f, evidenceId: ev.id, ref: ev.ref });
  return { ...ev, text: r.text, title: t.text };
}

export function ingestGithub(gh, people, findings = [], { qualify = false } = {}) {
  const out = [];
  const repo = gh.repo || "repository";
  // Extra repositories get the repo in their ids and refs, so issue #31 in two repos never collides.
  const q = qualify ? `${repo}:` : "";
  const rq = qualify ? `${repo} ` : "";
  for (const p of gh.pulls || []) {
    const merged = !!p.merged_at;
    const state = merged ? "merged" : p.state === "open" ? (p.draft ? "draft" : "open") : "closed";
    out.push(
      make(
        {
          id: `gh:${q}pr:${p.number}`,
          source: "github",
          kind: "pr",
          ref: `${rq}PR #${p.number}`,
          title: p.title,
          text: `${p.title}. ${p.body || ""}`.trim(),
          author: nameOf(p.user?.login, people),
          date: isoDate(p.merged_at || p.updated_at || p.created_at),
          visibility: "team",
          url: p.html_url || null,
          meta: { number: p.number, state, assignee: nameOf(p.assignee?.login, people), branch: p.head?.ref || null, repo, created: isoDate(p.created_at), updated: isoDate(p.updated_at) },
        },
        findings
      )
    );
  }
  for (const i of gh.issues || []) {
    if (i.pull_request) continue; // the GitHub issues API also returns PRs
    out.push(
      make(
        {
          id: `gh:${q}issue:${i.number}`,
          source: "github",
          kind: "issue",
          ref: `${rq}Issue #${i.number}`,
          title: i.title,
          text: `${i.title}. ${i.body || ""}`.trim(),
          author: nameOf(i.user?.login, people),
          date: isoDate(i.created_at),
          visibility: "team",
          url: i.html_url || null,
          meta: { number: i.number, state: i.state, assignee: nameOf(i.assignee?.login, people), labels: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)), created: isoDate(i.created_at), updated: isoDate(i.updated_at), closed: isoDate(i.closed_at), repo },
        },
        findings
      )
    );
  }
  for (const b of gh.branches || []) {
    if (!b.last_commit) continue;
    out.push(
      make(
        {
          id: `gh:${q}branch:${b.name}`,
          source: "github",
          kind: "branch",
          ref: `${rq}Branch ${b.name}`,
          title: b.name,
          text: `Branch ${b.name} was last updated on ${isoDate(b.last_commit)} by ${nameOf(b.author, people)}.`,
          author: nameOf(b.author, people),
          date: isoDate(b.last_commit),
          visibility: "team",
          meta: { branch: b.name, repo },
        },
        findings
      )
    );
  }
  // Commits: the message is often the only written record of why something changed.
  for (const c of gh.commits || []) {
    const msg = (c.commit?.message || c.message || "").replace(/\r/g, "").trim();
    if (!msg) continue;
    const sha = (c.sha || "").slice(0, 7);
    const lines = msg.split("\n").filter((l) => l.trim() && !/^(signed-off-by|co-authored-by):/i.test(l.trim()));
    const title = lines[0].trim();
    const body = lines.slice(1).join(" ").replace(/\s+/g, " ").trim();
    let text = body ? `${title}. ${body}` : title;
    if (text.length > 600) text = text.slice(0, 600).replace(/\s+\S*$/, "") + "…";
    out.push(
      make(
        {
          id: `gh:${q}commit:${sha}`,
          source: "github",
          kind: "commit",
          ref: `${rq}Commit ${sha}`,
          title,
          text,
          author: nameOf(c.author?.login, people) || c.commit?.author?.name || null,
          date: isoDate(c.commit?.author?.date || c.date),
          visibility: "team",
          url: c.html_url || null,
          meta: { sha, repo },
        },
        findings
      )
    );
  }
  // Markdown files from the repository (README, docs, decision records).
  for (const d of gh.docs || []) {
    out.push(...ingestDoc({ name: qualify ? `${repo}/${d.path}` : d.path, body: d.body, visibility: "team", modified: d.modified, author: null }, findings).map((e) => ({ ...e, meta: { ...e.meta, repo } })));
  }
  return out;
}

/** A document becomes one evidence item per line, so citations point at the exact line. */
export function ingestDoc(doc, findings = []) {
  const out = [];
  let section = null;
  let sectionDate = null;
  const lines = (doc.body || "").split(/\r?\n/);
  let inFence = false;
  let firstText = true;
  const SETUP = /(getting started|install|setup|set up|usage|how to (run|use|start)|running|run locally|quick ?start|deploy|build)/i;
  const OVERVIEW = /(overview|about|introduction|description|summary|what is)/i;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (!trimmed) return;
    if (inFence) {
      // Keep commands inside setup sections ("how to run it"); skip all other code.
      if (section && SETUP.test(section) && !/^(#|\/\/)/.test(trimmed) && trimmed.length <= 160) {
        out.push(make({ id: `doc:${doc.name}:${idx + 1}`, source: "docs", kind: "doc", ref: `${doc.name} › ${section}`, title: doc.name, text: trimmed, author: doc.author || null, date: sectionDate || isoDate(doc.modified) || null, visibility: doc.visibility || "team", meta: { doc: doc.name, line: idx + 1, section, code: true, setup: true } }, findings));
      }
      return;
    }
    // Badges, images, raw HTML and table rows are layout, not knowledge.
    if (/^(!\[|\[!\[|<|\|)/.test(trimmed)) return;
    const h = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      section = h[1].trim();
      sectionDate = isoDate(section);
      return;
    }
    const text = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [label](url) -> label
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1");
    // Scaffold boilerplate (create-next-app, create-react-app, Vite templates) says nothing about this project.
    if (/bootstrapped with|create-next-app|create-react-app|learn more about (next\.js|react|vite)|easiest way to deploy your next\.js|this template provides a minimal setup|you can start editing the page|this project uses next\/font|check out our next\.js deployment|to learn more about next\.js|getting started$/i.test(text)) return;
    if (text.replace(/[^A-Za-z0-9]/g, "").length < 3) return;
    const wasFirst = firstText;
    firstText = false;
    out.push(
      make(
        {
          id: `doc:${doc.name}:${idx + 1}`,
          source: "docs",
          kind: "doc",
          ref: `${doc.name}${section ? " › " + section.replace(/^\d{4}-\d{2}-\d{2}\s*/, "") : ""}`,
          title: doc.name,
          text,
          author: doc.author || null,
          date: sectionDate || isoDate(doc.modified) || null,
          visibility: doc.visibility || "team",
          meta: { doc: doc.name, line: idx + 1, section, setup: !!(section && SETUP.test(section)), overview: !!((section && OVERVIEW.test(section)) || (wasFirst && /readme/i.test(doc.name))) && !/^[A-Z][\w ]{1,30}:\s/.test(text) },
        },
        findings
      )
    );
  });
  return out;
}

export function ingestDocs(docs, findings = []) {
  return (docs || []).flatMap((d) => ingestDoc(d, findings));
}

/**
 * Chat export (Slack-style). Private channels and DMs are excluded by default.
 * Even when included, their visibility stays 'private', which no handover role can see.
 */
export function ingestChat(chat, people, { includePrivate = false } = {}, findings = []) {
  const out = [];
  const excluded = [];
  for (const ch of chat.channels || []) {
    const isPrivate = ch.is_private || ch.visibility === "private";
    if (isPrivate && !includePrivate) {
      excluded.push({ channel: ch.name, messages: (ch.messages || []).length });
      continue;
    }
    (ch.messages || []).forEach((m, idx) => {
      out.push(
        make(
          {
            id: `chat:${ch.name}:${idx + 1}`,
            source: "chat",
            kind: "message",
            ref: `#${ch.name} · ${nameOf(m.user, people)}`,
            title: `#${ch.name}`,
            text: m.text,
            author: nameOf(m.user, people),
            date: isoDate(m.ts),
            visibility: isPrivate ? "private" : ch.visibility || "team",
            meta: { channel: ch.name, index: idx + 1 },
          },
          findings
        )
      );
    });
  }
  return { evidence: out, excluded };
}

/** Parse an uploaded file into a doc or a chat export. Returns { kind, value } or throws. */
export function parseUpload(filename, content, visibility = "team") {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) {
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error(`${filename} is not valid JSON.`);
    }
    if (Array.isArray(data) && data.every((m) => typeof m === "object" && "text" in m)) {
      return { kind: "chat", value: { channels: [{ name: lower.replace(/\.json$/, ""), visibility, messages: data.map((m) => ({ user: m.user || m.user_name || m.author || "unknown", ts: m.ts && /^\d+(\.\d+)?$/.test(String(m.ts)) ? new Date(Number(m.ts) * 1000).toISOString() : m.ts || m.date, text: m.text })) }] } };
    }
    if (data && Array.isArray(data.channels)) return { kind: "chat", value: data };
    if (data && (Array.isArray(data.issues) || Array.isArray(data.pulls))) return { kind: "github", value: data };
    throw new Error(`${filename}: expected a chat export (array of messages with "text"), {channels:[...]}, or {issues, pulls}.`);
  }
  // WhatsApp-style text export: "12/10/2026, 18:00 - Priya: message"
  const wa = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+\d{1,2}:\d{2}(?:\s?[ap]m)?\s+-\s+([^:]+):\s+(.*)$/i;
  const lines = content.split(/\r?\n/);
  const waHits = lines.filter((l) => wa.test(l));
  if (lower.endsWith(".txt") && waHits.length >= 2 && waHits.length >= lines.filter((l) => l.trim()).length * 0.6) {
    const messages = waHits.map((l) => {
      const [, d, mo, y, user, text] = l.match(wa);
      const yyyy = y.length === 2 ? "20" + y : y;
      return { user: user.trim(), ts: `${yyyy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`, text };
    });
    return { kind: "chat", value: { channels: [{ name: lower.replace(/\.txt$/, ""), visibility, messages }] } };
  }
  if (/\.(md|markdown|txt)$/.test(lower)) {
    return { kind: "doc", value: { name: filename, visibility, modified: new Date().toISOString().slice(0, 10), body: content } };
  }
  throw new Error(`${filename}: unsupported file type. Use .md, .txt or .json.`);
}

/**
 * Live import from a public GitHub repository (unauthenticated REST API, 60 requests/hour).
 * Reads pull requests, issues, branches, the latest commits, and up to 8 Markdown files.
 * Markdown is read from raw.githubusercontent.com, which does not count against the API limit.
 */
export async function fetchGithubRepo(fullName, fetchImpl = fetch) {
  const clean = fullName.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error("Use the form owner/repo, for example vercel/swr.");
  const base = `https://api.github.com/repos/${clean}`;
  const H = { headers: { Accept: "application/vnd.github+json" } };
  const get = async (path) => {
    const r = await fetchImpl(base + path, H);
    if (r.status === 404) throw new Error(`Repository ${clean} not found or not public.`);
    if (r.status === 403 || r.status === 429) throw new Error("GitHub rate limit reached (60 requests per hour without sign-in). Try again later.");
    if (r.status === 409) return []; // empty repository
    if (!r.ok) throw new Error(`GitHub returned ${r.status}.`);
    return r.json();
  };
  const info = await get("");
  const branch = info.default_branch || "main";
  const soft = (p) => get(p).catch((e) => (/rate limit|not found/.test(e.message) ? Promise.reject(e) : []));
  const [pulls, issues, branches, commits, tree] = await Promise.all([
    soft("/pulls?state=all&per_page=40&sort=updated&direction=desc"),
    soft("/issues?state=all&per_page=60&sort=updated&direction=desc"),
    soft("/branches?per_page=30"),
    soft("/commits?per_page=50"),
    soft(`/git/trees/${encodeURIComponent(branch)}?recursive=1`),
  ]);
  // The branches list has no dates; fetch the head commit for up to 6 non-default branches.
  const named = (Array.isArray(branches) ? branches : []).filter((b) => b.name !== branch && !["main", "master"].includes(b.name)).slice(0, 6);
  const dated = await Promise.all(
    named.map(async (b) => {
      try {
        const c = await fetchImpl(b.commit.url, H).then((r) => r.json());
        return { name: b.name, last_commit: c?.commit?.committer?.date, author: c?.author?.login || c?.commit?.author?.name };
      } catch {
        return null;
      }
    })
  );
  const docs = await fetchMarkdown(clean, branch, tree, info.pushed_at, fetchImpl);
  return {
    repo: clean,
    description: info.description || "",
    defaultBranch: branch,
    pulls: Array.isArray(pulls) ? pulls : [],
    issues: Array.isArray(issues) ? issues : [],
    branches: dated.filter(Boolean),
    commits: Array.isArray(commits) ? commits : [],
    docs,
  };
}

const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|\.venv|venv|site-packages|third_party|\.github\/ISSUE_TEMPLATE)\//i;

/** Pick the most useful Markdown files: root README first, then docs/, then shallow files. */
export function pickMarkdown(tree, max = 8) {
  const files = (tree?.tree || []).filter((t) => t.type === "blob" && /\.(md|markdown)$/i.test(t.path) && !SKIP_DIRS.test(t.path) && (t.size == null || t.size <= 60000));
  const score = (p) => {
    const depth = p.split("/").length - 1;
    const name = p.split("/").pop().toLowerCase();
    let s = depth * 10;
    if (/^readme/.test(name)) s -= depth === 0 ? 100 : 5;
    if (/(^|\/)(docs?|adr|decisions?)\//i.test(p)) s -= 20;
    if (/(decision|adr|architecture|design|handover|changelog|contributing|setup)/i.test(name)) s -= 15;
    if (/(license|code_of_conduct|security)/i.test(name)) s += 50;
    return s;
  };
  return files.sort((a, b) => score(a.path) - score(b.path) || a.path.localeCompare(b.path)).slice(0, max).map((t) => t.path);
}

async function fetchMarkdown(repo, branch, tree, modified, fetchImpl) {
  const paths = pickMarkdown(tree);
  const got = await Promise.all(
    paths.map(async (path) => {
      try {
        const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
        const r = await fetchImpl(url);
        if (!r.ok) return null;
        const body = await r.text();
        return { path, body, modified: isoDate(modified) };
      } catch {
        return null;
      }
    })
  );
  return got.filter(Boolean);
}

export { sentences };
