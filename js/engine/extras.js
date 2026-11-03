// Round 1 commitments delivered in Round 2:
//  - successor readiness quiz (generated from the approved handover)
//  - citation spot-check sampling (human-measured citation accuracy)
//  - leaver effort accounting (active time in the gap interview)
// Pure functions: no DOM, tested in Node.

import { hash, tokens } from "./util.js";
import { topicName } from "./analyze.js";

/** Plausible alternatives per topic, used only as wrong options in the quiz. */
const ALTS = {
  hosting: ["Vercel", "Netlify", "Render", "Heroku"],
  auth: ["Firebase", "Supabase", "Auth0", "Clerk"],
  payments: ["Razorpay", "Stripe", "PayPal", "Cashfree"],
  push: ["Firebase", "OneSignal", "Pusher", "Expo Push"],
  database: ["Postgres", "MongoDB", "MySQL", "SQLite"],
};

function shuffle(arr, seed) {
  return arr
    .map((x, i) => ({ x, k: hash(`${seed}:${i}:${x}`) }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((o) => o.x);
}
function uniq(a) {
  return [...new Set(a.filter(Boolean))];
}
function shiftDate(d, days) {
  const m = d.match(/^(\d{1,2}) (\w{3})(?: (\d{4}))?$/);
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dt = new Date(Date.UTC(Number(m[3] || 2026), months.indexOf(m[2]), Number(m[1]) + days));
  return `${dt.getUTCDate()} ${months[dt.getUTCMonth()]}${m[3] ? " " + dt.getUTCFullYear() : ""}`;
}
function numberAlts(v) {
  const m = String(v).match(/^([\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return [];
  const n = Number(m[1].replace(/,/g, ""));
  const dec = (m[1].split(".")[1] || "").length;
  const fmt = (x) => (dec ? x.toFixed(dec) : Math.round(x).toLocaleString("en-US")) + m[2];
  return [fmt(n * 0.5), fmt(n * 2), fmt(n + (n >= 10 ? 10 : 1))].filter((x) => x !== v);
}

/**
 * Build up to `max` multiple-choice questions from a role's handover.
 * Every question points at the claim that answers it, so the result can be explained with sources.
 */
export function buildQuiz(ho, reviews = {}, max = 10) {
  const list = ho.list;
  const text = (c) => reviews[c.id]?.text || c.text;
  const qs = [];
  const add = (q) => {
    const opts = uniq([q.answer, ...q.wrong]).slice(0, 4);
    if (opts.length < 3) return;
    qs.push({ id: hash(q.prompt + "|" + q.claimId), prompt: q.prompt, answer: q.answer, options: shuffle(opts, q.prompt), claimId: q.claimId, explain: q.explain, kind: q.kind });
  };
  const people = uniq(list.filter((c) => c.person).map((c) => c.person).concat(ho.project?.leaver ? [ho.project.leaver] : []));

  // 1. Settled vs unsettled decisions (does the successor notice uncertainty?).
  const decisions = list.filter((c) => c.choice && (c.type === "decision" || c.topic?.startsWith("metric:")));
  for (const t of uniq(decisions.map((d) => d.topic))) {
    const ds = decisions.filter((d) => d.topic === t);
    const conflicting = ds.filter((d) => d.label === "Conflicting");
    const name = topicName(t);
    if (conflicting.length > 1) {
      const sides = conflicting.map((d) => d.choice);
      add({ kind: "uncertainty", prompt: `${name}: what is current?`, answer: `Not settled — sources disagree (${sides.join(" vs ")})`, wrong: sides, claimId: conflicting[0].id, explain: "The approved handover marks this as Conflicting. Confirm before building on either answer." });
    } else {
      const cur = ds.find((d) => d.confirmed) || ds[ds.length - 1];
      let wrong = (ho.sections.rejected || []).filter((r) => r.topic === t).map((r) => r.choice);
      if (t === "launch") wrong = wrong.concat([shiftDate(cur.choice, 7), shiftDate(cur.choice, -7)]);
      else if (t.startsWith("metric:")) wrong = wrong.concat(numberAlts(cur.choice.replace("%", "")).map((x) => x + "%"));
      else wrong = wrong.concat((ALTS[t] || []).filter((x) => x.toLowerCase() !== cur.choice.toLowerCase()));
      add({ kind: "decision", prompt: `${name}: what is current?`, answer: cur.choice, wrong: wrong.concat(["Not recorded anywhere"]), claimId: cur.id, explain: text(cur) });
    }
  }
  // 2. Ownership, including "nobody yet".
  for (const c of list.filter((c) => c.type === "owner" && c.item)) {
    const item = c.item.replace(/^(Issue|PR) /, "");
    if (c.missing) add({ kind: "owner", prompt: `Who owns ${item}?`, answer: "Nobody yet — it needs an owner", wrong: people.slice(0, 3), claimId: c.id, explain: text(c) });
    else if (c.person) add({ kind: "owner", prompt: `Who owns ${item}?`, answer: c.leaving ? `${c.person} (leaving — needs a new owner)` : c.person, wrong: people.filter((p) => p !== c.person).concat(["Nobody yet — it needs an owner"]), claimId: c.id, explain: text(c) });
  }
  // 3. Recurring problems.
  const recurring = list.filter((c) => c.type === "recurring");
  const recTok = new Set(recurring.flatMap((r) => tokens(r.text.match(/“(.+?)”/)?.[1] || "")));
  const decoys = list
    .filter((c) => c.type === "owner" && c.item && !recurring.some((r) => r.citations.some((x) => c.itemRef === x.evidenceId)))
    .map((c) => c.item.replace(/^(Issue|PR) #\d+ /, ""))
    .filter((d) => !tokens(d).some((t) => recTok.has(t)));
  for (const r of recurring) {
    const title = r.text.match(/“(.+?)”/)?.[1];
    if (title) add({ kind: "recurring", prompt: "Which of these problems keeps coming back?", answer: title, wrong: decoys.filter((d) => d !== title), claimId: r.id, explain: text(r) });
  }
  // 4. Short key facts ("Number of Epochs: 15").
  for (const f of list.filter((c) => c.type === "fact" && !c.topic)) {
    const m = f.text.match(/(?:— )?([A-Z][A-Za-z0-9 /()&.-]{1,40}):\s+(.{1,24})$/);
    if (!m) continue;
    const value = m[2].replace(/\.$/, "").trim();
    const others = list.filter((x) => x.type === "fact" && x !== f).map((x) => x.text.match(/:\s+(.{1,24})$/)?.[1]?.replace(/\.$/, "").trim());
    add({ kind: "fact", prompt: `${m[1].trim()}?`, answer: value, wrong: numberAlts(value).concat(others), claimId: f.id, explain: text(f) });
  }
  // Prefer a mix: uncertainty and decisions first, then owners, recurring, facts.
  const order = ["uncertainty", "decision", "owner", "recurring", "fact"];
  const picked = [];
  for (let round = 0; picked.length < max && round < 10; round++)
    for (const k of order) {
      const q = qs.filter((x) => x.kind === k)[round];
      if (q && picked.length < max) picked.push(q);
    }
  return picked;
}

export function scoreQuiz(questions, answers) {
  const right = questions.filter((q) => answers[q.id] === q.answer).length;
  return { right, total: questions.length, pct: questions.length ? Math.round((right / questions.length) * 100) : 0 };
}

/** Every citation as a checkable unit. */
export function citationUnits(claims) {
  return claims
    .filter((c) => c.status === "active")
    .flatMap((c) => c.citations.filter((x) => !x.evidenceId.startsWith("testimony:")).map((x) => ({ key: `${c.id}|${x.evidenceId}|${hash(x.quote)}`, claimId: c.id, evidenceId: x.evidenceId, quote: x.quote })));
}

/** A deterministic random sample of citations not yet checked. */
export function sampleCitations(claims, checked, n = 10, seed = 1) {
  const pool = citationUnits(claims).filter((u) => !(u.key in checked));
  return shuffle(pool, `spot:${seed}`).slice(0, n);
}

/** Measured citation accuracy from human spot-checks. */
export function spotAccuracy(checked) {
  const vals = Object.values(checked);
  const yes = vals.filter((v) => v === "yes").length;
  return { checked: vals.length, yes, pct: vals.length ? Math.round((yes / vals.length) * 1000) / 10 : null };
}

/** Leaver effort: active time in the interview; pauses longer than `idleCap` count as idleCap. */
export function addEffort(interview, now, idleCap = 5 * 60 * 1000) {
  const it = { activeMs: 0, actions: 0, ...interview };
  if (it.startedAt == null) return { ...it, startedAt: now, lastAt: now };
  const delta = Math.max(0, Math.min(now - (it.lastAt ?? now), idleCap));
  return { ...it, activeMs: it.activeMs + delta, lastAt: now, actions: it.actions + 1 };
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}
