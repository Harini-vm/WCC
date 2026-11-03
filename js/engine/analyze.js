// Reconstruct + Verify.
// Turns evidence into a Claim Ledger: typed claims, each with exact-quote citations and an
// evidence-based label. No claim exists without at least one citation that passes the checks.
//
// Claim: { id, type, label, status, text, topic, choice, citations:[{evidenceId, quote}],
//          basis, date, risk, item, person, conflictGroup, fix, answer }
// Labels: Verified | Single-source | Inferred | Conflicting | Missing

import { hash, sentences, tokens, jaccard, daysBetween, prettyDate } from "./util.js";
import { classify } from "./ml.js";

export const LABELS = ["Verified", "Single-source", "Inferred", "Conflicting", "Missing"];
export const TYPES = {
  decision: "Decision",
  owner: "Owner",
  action: "Next action",
  risk: "Risk",
  dependency: "Dependency",
  question: "Open question",
  recurring: "Recurring problem",
  contact: "Contact",
  progress: "Progress",
  budget: "Budget and money",
  overview: "About the project",
  setup: "How to run it",
  fact: "Key fact",
};

export const TOPICS = [
  { id: "push", name: "Push notifications", re: /push notification|cloud messaging|\bfcm\b/i },
  { id: "auth", name: "Authentication", re: /\bauth\b|\blogins?\b|sign[- ]?in|\bsessions?\b/i },
  { id: "payments", name: "Payments", re: /payment|checkout|razorpay|stripe|paypal|cashfree|\bupi\b/i },
  { id: "hosting", name: "Hosting", re: /\bhost(?:ing|ed)?\b|\bdeploy|vercel|netlify|heroku|railway/i },
  { id: "launch", name: "Launch date", re: /\blaunch/i },
  { id: "database", name: "Database", re: /\bdatabase\b|postgres|mongo|mysql|sqlite|dynamo/i },
];

const PROVIDERS = ["firebase", "supabase", "auth0", "clerk", "vercel", "netlify", "render", "heroku", "railway", "razorpay", "stripe", "paypal", "cashfree", "onesignal", "sendgrid", "postgres", "postgresql", "mongodb", "mysql", "sqlite", "dynamodb", "aws", "gcp", "azure"];
const PROV_RE = new RegExp(`\\b(${PROVIDERS.join("|")})\\b`, "gi");
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
const DATE_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+(\\d{4}))?`, "i");

const DECISION_RE = /\b(decided|decision|switch(?:ed|es|ing)?|mov(?:e|ed|es|ing)|replac\w*|migrat\w*|chose|choose|agreed|go(?:ing)? with|stays?|use[sd]?|using|deploy(?:ed)?\b[^.]*\bon|runs?\s+on|launch(?:es)?\s+on|launch\s+moved|dropped)\b/i;
const RISK_RE = /^risk:|\bmay not\b|\bat risk\b|\bdeadline\b|\bmight slip\b/i;
const DEP_RE = /\b(blocked (?:by|until|on)|waiting (?:on|for)|depends on|pending with|until [^.]*? sends)\b/i;
const PROGRESS_RE = /\b(is done|are done|completed|finished|shipped)\b/i;
const ACTION_RE = /^action:|\b(will|to)\s+(finish|hand over|send|fix|update|confirm|book|review|write|migrate|test|deploy|look at|take)\b|^i'?ll\b|\bi will\b/i;

function topicOf(s) {
  const t = TOPICS.find((x) => x.re.test(s));
  return t ? t.id : null;
}
// Names for topics discovered at run time (e.g. a metric two sources disagree on).
const DISCOVERED = new Map();
export function registerTopicName(id, name) {
  if (id && name && !TOPICS.some((t) => t.id === id)) DISCOVERED.set(id, name);
}
export function topicName(id) {
  return TOPICS.find((t) => t.id === id)?.name || DISCOVERED.get(id) || id;
}

function cap(p) {
  if (!p) return p;
  const special = { postgresql: "PostgreSQL", postgres: "Postgres", mongodb: "MongoDB", mysql: "MySQL", sqlite: "SQLite", dynamodb: "DynamoDB", aws: "AWS", gcp: "GCP", sendgrid: "SendGrid", onesignal: "OneSignal", auth0: "Auth0" };
  const k = p.toLowerCase();
  return special[k] || k[0].toUpperCase() + k.slice(1);
}

/** What does this sentence say is the current choice for its topic? */
export function choiceOf(s, topic) {
  if (topic === "launch") {
    const m = s.match(DATE_RE);
    return m ? `${Number(m[1])} ${m[2].slice(0, 3)}${m[3] ? " " + m[3] : ""}` : null;
  }
  const isProv = (w) => w && PROVIDERS.includes(w.toLowerCase());
  const pats = [
    /\b(?:switch\w*|mov\w*|replac\w*|migrat\w*)\b[^.;]*?\b(?:to|with)\s+(\w+)/i,
    /\b(?:stays?|runs?|deploy\w*|host\w*|is)\b[^.;]*?\bon\s+(\w+)/i,
    /\b(\w+)\s+stays?\b/i,
    /\b(?:use[sd]?|using|go(?:ing)? with|chose)\s+(\w+)/i,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m && isProv(m[1])) return cap(m[1]);
  }
  // Fallback: exactly one provider that is not being moved away from or dropped.
  const found = [...s.matchAll(PROV_RE)]
    .filter((m) => {
      const before = s.slice(Math.max(0, m.index - 6), m.index).toLowerCase();
      const after = s.slice(m.index, m.index + 40).toLowerCase();
      return !/from\s*$/.test(before) && !/dropped|ran out|costs|instead/.test(after);
    })
    .map((m) => m[1].toLowerCase());
  const uniq = [...new Set(found)];
  return uniq.length === 1 ? cap(uniq[0]) : null;
}

function personFromName(first, people) {
  const p = (people || []).find((x) => x.name.split(" ")[0].toLowerCase() === first.toLowerCase() || x.name.toLowerCase() === first.toLowerCase());
  return p ? p.name : first;
}

function addClaim(map, key, claim) {
  const id = claim.id || `${claim.type}:${hash(key)}`;
  const existing = map.get(id);
  if (existing) {
    for (const c of claim.citations) if (!existing.citations.some((x) => x.evidenceId === c.evidenceId)) existing.citations.push(c);
    if (claim.date && (!existing.date || claim.date < existing.date)) existing.date = claim.date;
    return existing;
  }
  const full = { status: "active", basis: "explicit", risk: 1, ...claim, id };
  map.set(id, full);
  return full;
}

/** Sentence-level extraction from one evidence item. */
function extractFrom(ev, ctx, map, chatQuestions) {
  if (ev.kind === "branch" || ev.source === "testimony") return;
  // Documentation structure: what the project is, how to run it, and key facts.
  if (ev.source === "docs") {
    const perDoc = (ctx._perDoc ||= {});
    const k = (t) => `${t}:${ev.meta?.doc}`;
    if (ev.meta?.setup) {
      perDoc[k("setup")] = (perDoc[k("setup")] || 0) + 1;
      if (perDoc[k("setup")] <= 6) addClaim(map, `setup:${ev.id}`, { type: "setup", text: ev.meta.code ? `Run: ${ev.text}` : ev.text, citations: [{ evidenceId: ev.id, quote: ev.text }], date: ev.date, risk: 1, area: ev.meta.doc });
      if (ev.meta.code) return;
    }
    const kv = ev.text.match(/^([A-Z][A-Za-z0-9 /()&.-]{1,40}):\s+(.{1,160})$/);
    if (kv && !/^(decision|owner|action|contact|risk|open question|attendees|note|example|source)$/i.test(kv[1].trim())) {
      addClaim(map, `fact:${ev.id}`, { type: "fact", text: `${ev.meta?.section ? ev.meta.section.replace(/[*#]/g, "").trim() + " — " : ""}${ev.text}`, citations: [{ evidenceId: ev.id, quote: ev.text }], date: ev.date, risk: 1, area: ev.meta?.doc });
      return;
    }
    if (ev.meta?.overview && !ev.meta?.setup) {
      perDoc[k("overview")] = (perDoc[k("overview")] || 0) + 1;
      const first = sentences(ev.text)[0];
      if (first && perDoc[k("overview")] <= 2 && first.split(/\s+/).length >= 6) addClaim(map, `overview:${ev.id}`, { type: "overview", text: first, citations: [{ evidenceId: ev.id, quote: first }], date: ev.date, risk: 1, area: ev.meta.doc });
    }
  }
  const sents = sentences(ev.text);
  let lastClaim = null;
  for (const s of sents) {
    const cite = [{ evidenceId: ev.id, quote: s }];
    const topic = topicOf(s);

    if (/^owner:/i.test(s)) {
      if (lastClaim) lastClaim.owner = s.replace(/^owner:\s*/i, "").replace(/\.$/, "");
      continue;
    }
    const looksLikeQuestion = /^open question:/i.test(s) || (s.trim().endsWith("?") && !/https?:\/\/|\S+\.\S+\/\S*\?$/.test(s) && s.split(/\s+/).length >= 3);
    if (looksLikeQuestion) {
      const q = s.replace(/^open question:\s*/i, "");
      if (ev.source === "chat") chatQuestions.push({ ev, s, q });
      else lastClaim = addClaim(map, `q:${ev.id}:${s}`, { type: "question", text: q, topic, citations: cite, date: ev.date, risk: 1 });
      continue;
    }
    if (/^contact:/i.test(s)) {
      lastClaim = addClaim(map, `c:${ev.id}:${s}`, { type: "contact", text: s.replace(/^contact:\s*/i, ""), citations: cite, date: ev.date });
      continue;
    }
    const own = s.match(/\b([A-Z][a-z]+)(?:\s[A-Z]\.?[a-z]*)?\s+owns\s+(?:the\s+)?([^.;]+)/);
    if (own) {
      const person = personFromName(own[1], ctx.people);
      const obj = own[2].trim();
      lastClaim = addClaim(map, `owner:${person}:${tokens(obj).sort().join(" ")}`, { type: "owner", text: `${person} owns the ${obj}.`, person, item: obj, citations: cite, date: ev.date, risk: 1 });
      continue;
    }
    if (topic && DECISION_RE.test(s) && !RISK_RE.test(s)) {
      const choice = choiceOf(s, topic);
      if (choice) {
        lastClaim = addClaim(map, `decision:${topic}:${choice.toLowerCase()}`, { type: "decision", topic, choice, text: s, citations: cite, date: ev.date, risk: 2 });
        continue;
      }
    }
    if (/(?:\bRs\.?|₹|\$|\bINR|\bUSD)\s?\d[\d,]*/.test(s) && !RISK_RE.test(s)) {
      lastClaim = addClaim(map, `b:${ev.id}:${s}`, { type: "budget", topic, text: s, citations: cite, date: ev.date, risk: 1 });
      continue;
    }
    if (RISK_RE.test(s)) {
      lastClaim = addClaim(map, `r:${ev.id}:${s}`, { type: "risk", topic, text: s.replace(/^risk:\s*/i, ""), citations: cite, date: ev.date, risk: 2 });
      continue;
    }
    if (DEP_RE.test(s)) {
      lastClaim = addClaim(map, `d:${ev.id}:${s}`, { type: "dependency", topic, text: s, citations: cite, date: ev.date, risk: ev.kind === "issue" ? 2 : 3 });
      continue;
    }
    if (topic && DECISION_RE.test(s) && ev.kind === "pr" && lastClaim?.type === "decision") {
      // e.g. "Firebase is dropped from auth." supports the PR's own decision.
      if (!lastClaim.citations.some((x) => x.quote === s)) lastClaim.citations.push({ evidenceId: ev.id, quote: s });
      continue;
    }
    if (PROGRESS_RE.test(s)) {
      lastClaim = addClaim(map, `p:${ev.id}:${s}`, { type: "progress", topic, text: `${ev.author ? ev.author + ": " : ""}${s}`, citations: cite, date: ev.date });
      continue;
    }
    if (ACTION_RE.test(s) && ev.kind !== "issue" && ev.kind !== "pr") {
      const who = /^i'?ll\b|\bi will\b/i.test(s) && ev.author ? `${ev.author}: ` : "";
      lastClaim = addClaim(map, `a:${ev.id}:${s}`, { type: "action", topic, text: who + s.replace(/^action:\s*/i, ""), citations: cite, date: ev.date, risk: 1 });
      continue;
    }
  }
}

/** Structured claims from GitHub state: owners, missing owners, idle branches, recurring problems. */
function structural(evidence, ctx, map) {
  const items = evidence.filter((e) => e.source === "github" && (e.kind === "issue" || e.kind === "pr"));
  for (const e of items) {
    const open = ["open", "draft"].includes(e.meta.state);
    if (!open) continue;
    const cite = [{ evidenceId: e.id, quote: e.title }];
    const age = ctx.today && e.meta.updated ? daysBetween(e.meta.updated, ctx.today) : null;
    if (!e.meta.assignee) {
      addClaim(map, `missing-owner:${e.id}`, {
        id: `owner:missing:${e.id}`,
        type: "owner",
        missing: true,
        item: `${e.ref} ${e.title}`,
        itemRef: e.id,
        text: `${e.ref} “${e.title}” has no owner${age != null ? ` (no activity for ${age} days)` : ""}.`,
        citations: cite,
        date: e.date,
        risk: /launch|venue|payment|invoice|sponsor|security|checkout/i.test(e.text) ? 3 : 2,
      });
    } else {
      const leaving = ctx.leaver && e.meta.assignee === ctx.leaver;
      addClaim(map, `assignee:${e.id}`, {
        id: `owner:assigned:${e.id}`,
        type: "owner",
        person: e.meta.assignee,
        leaving,
        item: `${e.ref} ${e.title}`,
        itemRef: e.id,
        text: `${e.meta.assignee}${leaving ? " (leaving)" : ""} owns ${e.ref} “${e.title}”${e.meta.state === "draft" ? " — still a draft" : ""}.`,
        citations: cite,
        date: e.date,
        risk: leaving ? 2 : 1,
      });
    }
  }
  // Idle branches = unfinished work.
  for (const b of evidence.filter((e) => e.kind === "branch")) {
    if (["main", "master", "develop"].includes(b.meta.branch)) continue;
    const idle = ctx.today && b.date ? daysBetween(b.date, ctx.today) : 0;
    if (idle >= 14) {
      addClaim(map, `idle:${b.id}`, {
        id: `risk:idle:${b.id}`,
        type: "risk",
        basis: "inferred",
        text: `Branch ${b.meta.branch} has had no commits for ${idle} days — likely unfinished work${b.author ? ` by ${b.author}` : ""}.`,
        citations: [{ evidenceId: b.id, quote: b.text }],
        date: b.date,
        risk: b.author === ctx.leaver ? 3 : 2,
      });
    }
  }
  // Commit-based signals.
  const commits = evidence.filter((e) => e.kind === "commit").sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (commits.length) {
    // Recent changes: the latest commits, so a successor knows what moved last.
    for (const c of commits.slice(0, 6)) {
      addClaim(map, `recent:${c.id}`, { id: `progress:commit:${c.id}`, type: "progress", text: `${c.author ? c.author + ": " : ""}${c.title}`, citations: [{ evidenceId: c.id, quote: c.title }], date: c.date, risk: 1 });
    }
    // Knowledge concentration: how much of the recent code history is the leaver's.
    if (ctx.leaver && commits.length >= 3) {
      const mine = commits.filter((c) => c.author === ctx.leaver);
      const share = mine.length / commits.length;
      if (share >= 0.5) {
        addClaim(map, `concentration:${ctx.leaver}`, {
          id: `risk:concentration`,
          type: "risk",
          basis: "inferred",
          text: `${ctx.leaver} wrote ${mine.length} of the last ${commits.length} commits (${Math.round(share * 100)}%) — most recent code knowledge sits with them.`,
          citations: mine.slice(0, 4).map((c) => ({ evidenceId: c.id, quote: c.title })),
          date: mine[0].date,
          risk: share >= 0.8 ? 3 : 2,
        });
      }
    }
  }

  // Recurring problems: cluster issues and bug-fix commits by title similarity (union-find).
  const FIXWORDS = new Set(["fix", "bug", "hotfix", "patch", "issue", "error", "updat", "chang"]);
  const issues = evidence.filter((e) => e.kind === "issue" || (e.kind === "commit" && /\b(fix(e[sd])?|hotfix|bug|patch(ed)?)\b/i.test(e.title)));
  const parent = issues.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const toks = issues.map((e) => tokens(e.title).filter((t) => !FIXWORDS.has(t)));
  for (let i = 0; i < issues.length; i++)
    for (let j = i + 1; j < issues.length; j++) if (toks[i].length && toks[j].length && jaccard(toks[i], toks[j]) >= 0.34) parent[find(i)] = find(j);
  const groups = new Map();
  issues.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  });
  const recurring = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const first = g[0];
    const stillOpen = g.some((e) => e.meta?.state === "open");
    const fixes = g.flatMap((e) => sentences(e.text).filter((s) => /\b(fixed by|workaround|restart\w*|resolved by)\b/i.test(s)).map((s) => ({ evidenceId: e.id, quote: s })));
    const key = tokens(first.title).sort().join(" ");
    const refs = g.map((e) => e.ref.replace(/Issue /, "").replace(/Commit /, "commit ")).join(", ");
    const c = addClaim(map, `recurring:${key}`, {
      id: `recurring:${hash(key)}`,
      type: "recurring",
      basis: "inferred",
      text: `Recurring problem: “${first.title}” has happened ${g.length} times (${refs})${stillOpen ? " and is open again" : ""}.${fixes.length ? " Only a manual workaround is recorded." : " No fix is recorded."}`,
      citations: [...g.map((e) => ({ evidenceId: e.id, quote: e.title })), ...fixes],
      date: g[g.length - 1].date,
      risk: stillOpen ? 3 : 2,
      clusterKey: key,
      memberRefs: g.map((e) => e.id),
    });
    recurring.push({ claim: c, tokens: tokens(g.map((e) => e.title).join(" ")) });
  }
  return recurring;
}

function evidenceSources(claim, byId) {
  return new Set(claim.citations.map((c) => byId.get(c.evidenceId)?.source).filter(Boolean));
}

/** Check each citation: quote must exist verbatim in the evidence and share key terms with the claim. */
export function checkCitations(claims, byId) {
  let checked = 0;
  let dropped = 0;
  const kept = [];
  for (const c of claims) {
    const ok = c.citations.filter((cit) => {
      checked++;
      const ev = byId.get(cit.evidenceId);
      const exact = ev && cit.quote && ev.text.includes(cit.quote);
      let supports = exact;
      if (exact && c.type === "decision" && c.choice && ev.source !== "testimony") {
        const q = cit.quote.toLowerCase();
        supports = (c.choice && q.includes(c.choice.toLowerCase().split(" ")[0])) || TOPICS.find((t) => t.id === c.topic)?.re.test(cit.quote);
      }
      if (!supports) dropped++;
      return supports;
    });
    if (ok.length) kept.push({ ...c, citations: ok });
  }
  return { claims: kept, checked, dropped };
}

/**
 * Full analysis.
 * @param evidence  normalised evidence (incl. testimony)
 * @param ctx       { leaver, today, people, answers: { [gapId]: {choice, text, owner, skipped, at} } }
 */
export function analyze(evidence, ctx0 = {}) {
  const ctx = { ...ctx0, _perDoc: {} };
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const map = new Map();
  const chatQuestions = [];
  const sorted = [...evidence].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  for (const ev of sorted) extractFrom(ev, ctx, map, chatQuestions);

  // Chat questions count as open only if the next message in the channel does not answer them.
  for (const { ev, s, q } of chatQuestions) {
    const next = evidence.find((x) => x.source === "chat" && x.meta?.channel === ev.meta.channel && x.meta.index === ev.meta.index + 1);
    const answered = next && next.author !== ev.author && jaccard(tokens(q), tokens(next.text)) > 0.05 && tokens(q).some((t) => tokens(next.text).includes(t));
    if (!answered) addClaim(map, `q:${ev.id}:${s}`, { type: "question", text: q, topic: topicOf(q), citations: [{ evidenceId: ev.id, quote: s }], date: ev.date, risk: 2 });
  }

  const recurring = structural(evidence, ctx, map);

  // AI extraction: sentences no rule recognised. Every AI claim keeps an exact quote and is
  // labelled Inferred, so a person must approve it; the second model's verdict is attached.
  const aiStats = { mode: ctx.ai || "off", considered: 0, accepted: 0, verified: 0 };
  if (ctx.ai && ctx.ai !== "off") {
    const covered = new Set();
    for (const c of map.values()) for (const x of c.citations) covered.add(`${x.evidenceId}|${x.quote}`);
    for (const q of chatQuestions) covered.add(`${q.ev.id}|${q.s}`);
    for (const ev of evidence) {
      if (["branch", "issue"].includes(ev.kind) || ev.source === "testimony" || ev.meta?.code) continue;
      for (const sn of sentences(ev.text)) {
        if (covered.has(`${ev.id}|${sn}`) || sn.split(/\s+/).length < 4 || /^(owner|contact|attendees):/i.test(sn)) continue;
        aiStats.considered++;
        const proposed = ctx.ai === "claude" ? ctx.llm?.[`${ev.id}|${sn}`] : null;
        if (ctx.ai === "claude" && !proposed) continue;
        const r = classify(sn, proposed ? { proposed } : {});
        if (!r.accepted) continue;
        aiStats.accepted++;
        if (r.verified) aiStats.verified++;
        const topic = topicOf(sn);
        const choice = r.label === "decision" && topic ? choiceOf(sn, topic) : null;
        addClaim(map, `ai:${ev.id}:${sn}`, {
          type: r.label,
          basis: "ai",
          ai: { p: r.p, verified: r.verified, by: proposed ? "Claude" : "built-in model", second: r.verifierLabel },
          text: sn,
          topic,
          choice,
          citations: [{ evidenceId: ev.id, quote: sn }],
          date: ev.date,
          risk: r.label === "dependency" ? 3 : r.label === "risk" ? 2 : 1,
        });
      }
    }
  }

  // Attach chat hints about recurring problems (e.g. "I'll look at the SSL renewal issue...").
  for (const r of recurring) {
    for (const c of map.values()) {
      if (c === r.claim || c.type === "recurring") continue;
      if (c.type === "action" && jaccard(tokens(c.text), r.tokens) >= 0.12 && tokens(c.text).filter((t) => r.tokens.includes(t)).length >= 2) {
        c.relatedTo = r.claim.id;
      }
    }
  }

  // Mark actions done when a progress update covers them.
  const progress = [...map.values()].filter((c) => c.type === "progress");
  for (const a of [...map.values()].filter((c) => c.type === "action")) {
    const p = progress.find((p) => tokens(p.text).filter((t) => tokens(a.text).includes(t)).length >= 2);
    if (p) {
      a.done = true;
      a.doneBy = p.id;
    }
  }

  let { claims, checked, dropped } = checkCitations([...map.values()], byId);

  // Conflicts: same topic, different choices.
  const conflicts = [];
  const byTopic = new Map();
  // Numeric contradictions: near-identical sentences that state different percentages
  // (e.g. "accuracy of approximately 90%" vs "approximately 98%").
  const PCT = /(\d+(?:\.\d+)?)\s?%/;
  const pctSents = [];
  for (const ev of evidence) {
    if (ev.source === "testimony" || ev.kind === "branch") continue;
    for (const s of sentences(ev.text)) {
      const m = s.match(PCT);
      if (m) pctSents.push({ ev, s, value: `${Number(m[1])}%`, toks: tokens(s.replace(/\d+(\.\d+)?\s?%/g, " ")) });
    }
  }
  for (let i = 0; i < pctSents.length; i++)
    for (let j = i + 1; j < pctSents.length; j++) {
      const a = pctSents[i], b = pctSents[j];
      if (a.value === b.value || a.toks.length < 3 || jaccard(a.toks, b.toks) < 0.5) continue;
      const shared = a.toks.filter((t) => b.toks.includes(t));
      const words = a.s.split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, "")).filter((w) => w.length > 3 && shared.includes(tokens(w)[0]));
      const id = `metric:${hash(shared.sort().join(" "))}`;
      DISCOVERED.set(id, words.slice(0, 4).join(" ").replace(/^./, (c) => c.toUpperCase()) || "A figure");
      for (const x of [a, b]) {
        const key = `metric:${id}:${x.value}`;
        const cl = map.get(`fact:${hash(key)}`) || addClaim(map, key, { id: `fact:${hash(key)}`, type: "fact", topic: id, choice: x.value, text: x.s, citations: [], date: x.ev.date, risk: 2 });
        if (!cl.citations.some((c) => c.quote === x.s && c.evidenceId === x.ev.id)) cl.citations.push({ evidenceId: x.ev.id, quote: x.s });
        if (!claims.includes(cl)) claims.push(cl);
      }
    }
  for (const c of claims.filter((c) => (c.type === "decision" || (c.type === "fact" && c.topic?.startsWith("metric:"))) && c.choice)) {
    if (!byTopic.has(c.topic)) byTopic.set(c.topic, []);
    byTopic.get(c.topic).push(c);
  }
  for (const [topic, list] of byTopic) {
    const choices = new Set(list.map((c) => c.choice.toLowerCase()));
    if (choices.size > 1) {
      list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      list.forEach((c) => (c.conflictGroup = topic));
      conflicts.push({ topic, claims: list.map((c) => c.id) });
    }
  }

  // Apply Gap Interview answers (testimony).
  const answers = ctx.answers || {};
  const testimonyFor = (gapId) => evidence.find((e) => e.id === `testimony:${gapId}`);
  for (const conf of conflicts) {
    const gapId = `gap:conflict:${conf.topic}`;
    const a = answers[gapId];
    const t = testimonyFor(gapId);
    if (!a || a.skipped || !t || !a.choice) continue;
    conf.resolved = a.choice;
    for (const id of conf.claims) {
      const c = claims.find((x) => x.id === id);
      if (c.choice.toLowerCase() === a.choice.toLowerCase()) {
        c.citations.push({ evidenceId: t.id, quote: t.text });
        c.confirmed = true;
      } else {
        c.status = "superseded";
        c.supersededBy = a.choice;
      }
    }
  }
  for (const c of claims) {
    if (c.type === "owner" && c.itemRef) {
      const gapId = c.missing ? `gap:owner:${c.itemRef}` : c.leaving ? `gap:handoff:${c.itemRef}` : null;
      const a = gapId && answers[gapId];
      const t = gapId && testimonyFor(gapId);
      if (a && !a.skipped && t && a.owner) {
        c.status = "resolved";
        const ev = byId.get(c.itemRef);
        claims.push({
          id: `owner:new:${c.itemRef}`,
          type: "owner",
          status: "active",
          basis: "explicit",
          person: a.owner,
          item: c.item,
          itemRef: c.itemRef,
          text: `${a.owner} now owns ${ev.ref} “${ev.title}”${a.text ? ` — ${a.text}` : ""}.`,
          citations: [{ evidenceId: ev.id, quote: ev.title }, { evidenceId: t.id, quote: t.text }],
          confirmed: true,
          date: t.date,
          risk: 1,
        });
      }
    }
    if (c.type === "recurring") {
      const gapId = `gap:recurring:${c.id}`;
      const a = answers[gapId];
      const t = testimonyFor(gapId);
      if (a && !a.skipped && t) {
        c.citations.push({ evidenceId: t.id, quote: t.text });
        c.confirmed = true;
        c.fix = a.text;
      }
    }
    if (c.type === "question") {
      const gapId = `gap:question:${c.id}`;
      const a = answers[gapId];
      const t = testimonyFor(gapId);
      if (a && !a.skipped && t) {
        c.citations.push({ evidenceId: t.id, quote: t.text });
        c.confirmed = true;
        c.answer = a.text;
      }
    }
  }

  // Labels — computed from evidence, never from model confidence.
  for (const c of claims) {
    const srcs = evidenceSources(c, byId);
    if (c.confirmed) c.label = "Verified";
    else if (c.type === "question" || c.missing) c.label = "Missing";
    else if (c.conflictGroup && c.status !== "superseded" && !conflicts.find((x) => x.topic === c.conflictGroup)?.resolved) c.label = "Conflicting";
    else if (c.basis === "inferred" || c.basis === "ai") c.label = "Inferred";
    else if (srcs.size >= 2) c.label = "Verified";
    else c.label = "Single-source";
  }

  const gaps = buildGaps(claims, conflicts, byId, ctx);
  const stats = {
    evidence: evidence.length,
    bySource: countBy(evidence, (e) => e.source),
    claims: claims.length,
    byLabel: countBy(claims.filter((c) => c.status === "active"), (c) => c.label),
    byType: countBy(claims.filter((c) => c.status === "active"), (c) => c.type),
    ai: aiStats,
    citationsChecked: checked,
    citationsDropped: dropped,
  };
  return { claims, conflicts, gaps, stats };
}

function countBy(arr, f) {
  const o = {};
  for (const x of arr) {
    const k = f(x);
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

const RISK_NAME = { 3: "High", 2: "Medium", 1: "Low" };
export function riskName(n) {
  return RISK_NAME[n] || "Low";
}

/** Gap Interview questions: only where evidence is missing or contradicts itself. Ranked by risk. */
export function buildGaps(claims, conflicts, byId, ctx) {
  const gaps = [];
  const answers = ctx.answers || {};
  const refs = (c) => [...new Set(c.citations.map((x) => byId.get(x.evidenceId)?.ref).filter(Boolean))];
  for (const conf of conflicts) {
    const opts = conf.claims.map((id) => claims.find((c) => c.id === id)).filter(Boolean);
    const byChoice = new Map();
    for (const c of opts) {
      const k = c.choice;
      if (!byChoice.has(k)) byChoice.set(k, []);
      byChoice.get(k).push(...refs(c).filter((r) => !r.startsWith("Gap interview")));
    }
    gaps.push({
      id: `gap:conflict:${conf.topic}`,
      type: "conflict",
      risk: 3,
      title: `${topicName(conf.topic)}: sources disagree`,
      prompt: `${[...byChoice].map(([ch, r]) => `${ch} (${r.join(", ")})`).join(" vs ")}. Which is current?`,
      options: [...byChoice.keys()],
      claimIds: conf.claims,
    });
  }
  for (const c of claims) {
    if (c.type === "owner" && c.missing) {
      gaps.push({ id: `gap:owner:${c.itemRef}`, type: "owner", risk: c.risk, title: "Missing owner", prompt: `${c.text} Who should own it?`, claimIds: [c.id] });
    }
    if (c.type === "owner" && c.leaving) {
      gaps.push({ id: `gap:handoff:${c.itemRef}`, type: "handoff", risk: 2, title: "Your open work", prompt: `You own ${c.item}. Who takes it over, and what state is it in?`, claimIds: [c.id] });
    }
    if (c.type === "recurring") {
      gaps.push({ id: `gap:recurring:${c.id}`, type: "recurring", risk: c.risk, title: "Recurring problem", prompt: `${c.text.replace(/^Recurring problem: /, "")} Is there a permanent fix or a known cause?`, claimIds: [c.id] });
    }
    if (c.type === "question") {
      gaps.push({ id: `gap:question:${c.id}`, type: "question", risk: c.risk, title: "Unanswered question", prompt: `“${c.text}” (${refs(c).join(", ")}) Do you know the answer?`, claimIds: [c.id] });
    }
  }
  for (const g of gaps) {
    const a = answers[g.id];
    g.status = !a ? "open" : a.skipped ? "skipped" : "answered";
  }
  gaps.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
  return gaps;
}

/** Testimony evidence from a Gap Interview answer. */
export function testimonyEvidence(gap, answer, leaver) {
  let text;
  if (gap.type === "conflict") text = `${answer.choice} is current for ${gap.title.split(":")[0].toLowerCase()}.${answer.text ? " " + answer.text : ""}`;
  else if (gap.type === "owner" || gap.type === "handoff") text = `${answer.owner} should own this.${answer.text ? " " + answer.text : ""}`;
  else text = answer.text;
  return {
    id: `testimony:${gap.id}`,
    source: "testimony",
    kind: "answer",
    ref: `Gap interview · ${leaver}`,
    title: gap.title,
    text,
    author: leaver,
    date: answer.at,
    visibility: answer.visibility || "team",
    meta: { gapId: gap.id, prompt: gap.prompt },
  };
}

export { prettyDate };

/**
 * The rule engine's label for a single sentence, using the same patterns and precedence as
 * extraction. Used to compare rules against the AI on the held-out test set.
 */
export function ruleTypeOf(s) {
  if (/^open question:/i.test(s) || (s.trim().endsWith("?") && !/https?:\/\/|\S+\.\S+\/\S*\?$/.test(s) && s.split(/\s+/).length >= 3)) return "question";
  if (/^contact:/i.test(s) || /^owner:/i.test(s)) return "none";
  if (/\b([A-Z][a-z]+)(?:\s[A-Z]\.?[a-z]*)?\s+owns\s+/.test(s)) return "none";
  const topic = topicOf(s);
  if (topic && DECISION_RE.test(s) && !RISK_RE.test(s) && choiceOf(s, topic)) return "decision";
  if (/(?:\bRs\.?|₹|\$|\bINR|\bUSD)\s?\d[\d,]*/.test(s) && !RISK_RE.test(s)) return "none";
  if (RISK_RE.test(s)) return "risk";
  if (DEP_RE.test(s)) return "dependency";
  if (PROGRESS_RE.test(s)) return "none";
  if (ACTION_RE.test(s)) return "action";
  return "none";
}
