// Handover: role-filtered, approved-only views of the Claim Ledger.
// Permission rule: a claim appears in a role's view only if EVERY piece of evidence it cites
// is visible to that role. Private evidence is visible to no role.

import { topicName, TYPES, riskName } from "./analyze.js";
import { prettyDate, tokens } from "./util.js";

export const ROLES = {
  developer: { name: "Developer", sees: ["team"], blurb: "Code, decisions, risks and owners. No leads-only material." },
  lead: { name: "Club lead", sees: ["team", "leads"], blurb: "Everything a developer sees, plus leads-only budget and partner notes." },
};

export function visibleTo(role, ev) {
  return !!ev && ROLES[role].sees.includes(ev.visibility);
}

/** Approved, active claims the role may see. */
export function claimsFor(role, claims, byId, reviews) {
  return claims.filter((c) => {
    if (c.status !== "active") return false;
    const r = reviews[c.id];
    if (!r || r.status !== "approved") return false;
    return c.citations.every((cit) => visibleTo(role, byId.get(cit.evidenceId)));
  });
}

function textOf(c, reviews) {
  return reviews[c.id]?.text || c.text;
}

/** Ordered first-72-hours plan, each step linked to the claim it comes from. */
export function plan(list, reviews) {
  const steps = [];
  const add = (c, why, verb) => steps.push({ claimId: c.id, text: verb ? `${verb}${textOf(c, reviews)}` : textOf(c, reviews), why, risk: c.risk });
  const conflictTopics = [...new Set(list.filter((c) => c.label === "Conflicting" && c.type === "decision").map((c) => c.topic))];
  for (const t of conflictTopics) {
    const cs = list.filter((c) => c.label === "Conflicting" && c.topic === t);
    steps.push({ claimId: cs[0].id, text: `Confirm the current ${topicName(t).toLowerCase()}: ${cs.map((c) => c.choice).join(" or ")}?`, why: "Sources disagree — confirm before building on it", risk: 3 });
  }
  list.filter((c) => c.type === "dependency").forEach((c) => add(c, "Blocks other work", "Chase the blocker: "));
  list.filter((c) => c.type === "owner" && c.missing).forEach((c) => add(c, "Nobody is responsible yet", "Assign an owner: "));
  list.filter((c) => c.type === "owner" && c.leaving).forEach((c) => add(c, "The leaver owned it", "Take over or reassign: "));
  list.filter((c) => c.type === "recurring" && c.risk >= 3).forEach((c) => add(c, c.fix ? "A fix is known — apply it" : "It will happen again", c.fix ? "Apply the known fix: " : "Find a permanent fix: "));
  list.filter((c) => c.type === "risk" && c.risk >= 3).forEach((c) => add(c, "High-risk unfinished work", "Review: "));
  list.filter((c) => c.type === "question" && c.label === "Missing").forEach((c) => add(c, "Still unanswered", "Get an answer: "));
  list.filter((c) => c.type === "action" && !c.done).forEach((c) => add(c, "Open action from the sources", ""));
  const seen = new Set();
  return steps.filter((s) => (seen.has(s.claimId) ? false : seen.add(s.claimId))).map((s, i) => ({ ...s, day: i < 4 ? "Day 1" : i < 8 ? "Day 2" : "Day 3" }));
}

/** Build the handover document for a role. */
export function buildHandover({ role, claims, evidence, reviews, project }) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const list = claimsFor(role, claims, byId, reviews);
  const decisions = list.filter((c) => (c.type === "decision" || (c.type === "fact" && c.topic?.startsWith("metric:"))) && c.choice).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const topics = [...new Set(decisions.map((d) => d.topic))];
  const stateLines = topics.map((t) => {
    const ds = decisions.filter((d) => d.topic === t);
    const conflicting = ds.filter((d) => d.label === "Conflicting");
    if (conflicting.length > 1) return { topic: topicName(t), value: `unresolved — ${conflicting.map((d) => d.choice).join(" vs ")}`, uncertain: true };
    const cur = ds.find((d) => d.confirmed) || ds[ds.length - 1];
    return { topic: topicName(t), value: cur.choice, uncertain: cur.label !== "Verified", label: cur.label };
  });
  // Rejected options: choices the gap interview superseded, kept in the timeline as history.
  const rejected = claims
    .filter((c) => c.status === "superseded" && c.citations.every((cit) => visibleTo(role, byId.get(cit.evidenceId))) && list.some((x) => x.topic === c.topic && x.confirmed))
    .map((c) => ({ ...c, rejected: true }));
  const sections = {
    state: stateLines,
    rejected,
    timeline: decisions.concat(rejected, list.filter((c) => c.type === "progress")).sort((a, b) => (a.date || "").localeCompare(b.date || "")),
    open: list.filter((c) => c.label === "Conflicting" || c.label === "Missing" || c.type === "question"),
    risks: list.filter((c) => ["risk", "dependency", "recurring"].includes(c.type)).sort((a, b) => b.risk - a.risk),
    people: list.filter((c) => c.type === "owner" || c.type === "contact"),
    money: list.filter((c) => c.type === "budget"),
    about: list.filter((c) => c.type === "overview"),
    setup: list.filter((c) => c.type === "setup"),
    facts: list.filter((c) => c.type === "fact" && c.label !== "Conflicting"),
    plan: plan(list, reviews),
  };
  const hidden = claims.filter((c) => c.status === "active" && reviews[c.id]?.status === "approved" && !list.includes(c)).length;
  return { role, roleName: ROLES[role].name, project, list, sections, hiddenForPermissions: hidden };
}

/** Structural leak check: no claim in the view may cite evidence the role cannot see. */
export function leakCheck(handover, evidence) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const bad = [];
  for (const c of handover.list) for (const cit of c.citations) if (!visibleTo(handover.role, byId.get(cit.evidenceId))) bad.push({ claimId: c.id, evidenceId: cit.evidenceId });
  return { ok: bad.length === 0, violations: bad };
}

/** Answer a successor's question only from approved claims they can see. */
export function ask(question, handover, reviews) {
  const q = tokens(question);
  if (!q.length) return { answer: null, matches: [] };
  const scored = handover.list
    .map((c) => {
      const t = tokens(`${textOf(c, reviews)} ${c.topic ? topicName(c.topic) : ""} ${c.choice || ""} ${c.person || ""} ${TYPES[c.type]} ${c.answer || ""} ${c.fix || ""}`);
      const hits = q.filter((w) => t.includes(w)).length;
      return { c, score: hits / q.length };
    })
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score || b.c.risk - a.c.risk)
    .slice(0, 3);
  return { matches: scored.map((s) => s.c) };
}

/** Markdown export with citations. */
export function toMarkdown(h, evidence, reviews, version) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const cite = (c) => c.citations.map((x) => byId.get(x.evidenceId)?.ref).filter(Boolean).join("; ");
  const line = (c) => `- **[${c.label}]** ${textOf(c, reviews)}${c.answer ? ` — Answer: ${c.answer}` : ""}${c.fix ? ` — Fix: ${c.fix}` : ""}  \n  _Sources: ${cite(c)}_`;
  const out = [];
  out.push(`# Handover: ${h.project.name} — ${h.roleName} view`);
  out.push(`Leaver: ${h.project.leaver} · Exit: ${prettyDate(h.project.exitDate)}${version ? ` · Approved version ${version.n} by ${version.by} on ${prettyDate(version.at.slice(0, 10))}` : ""}`);
  out.push(`\nLabels: Verified = 2+ sources agree or confirmed by a person · Single-source · Inferred = pattern-based, check it · Conflicting · Missing.`);
  if (h.sections.about.length) {
    out.push(`\n## About the project`);
    h.sections.about.forEach((c) => out.push(line(c)));
  }
  out.push(`\n## Project state`);
  for (const s of h.sections.state) out.push(`- ${s.topic}: ${s.value}${s.uncertain && !/unresolved/.test(s.value) ? ` (${s.label})` : ""}`);
  out.push(`\n## First 72 hours`);
  h.sections.plan.forEach((p, i) => out.push(`${i + 1}. [${p.day}] ${p.text} — ${p.why}`));
  out.push(`\n## Decision timeline`);
  for (const c of h.sections.timeline) out.push(c.rejected ? `- ${prettyDate(c.date)}: ~~${c.text}~~ — rejected option, superseded by ${c.supersededBy} _(${cite(c)})_` : `- ${prettyDate(c.date)}: ${textOf(c, reviews)} [${c.label}] _(${cite(c)})_`);
  out.push(`\n## Open questions and conflicts`);
  h.sections.open.forEach((c) => out.push(line(c)));
  out.push(`\n## Risks, blockers and recurring problems`);
  h.sections.risks.forEach((c) => out.push(line(c)));
  out.push(`\n## Who owns what, and who to ask`);
  h.sections.people.forEach((c) => out.push(line(c)));
  if (h.sections.setup.length) {
    out.push(`\n## How to run it`);
    h.sections.setup.forEach((c) => out.push(line(c)));
  }
  if (h.sections.facts.length) {
    out.push(`\n## Key facts`);
    h.sections.facts.forEach((c) => out.push(line(c)));
  }
  if (h.sections.money.length) {
    out.push(`\n## Budget and money`);
    h.sections.money.forEach((c) => out.push(line(c)));
  }
  out.push(`\n---\nGenerated by Baton. ${h.hiddenForPermissions} approved item(s) were withheld from this view by permission rules.`);
  return out.join("\n");
}

export { riskName };
