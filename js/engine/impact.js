// Exit impact: what knowledge is tied to the person leaving, and how much of it is secured.
// Produces "knowledge units", a weighted Handover Readiness Score (0–100), and a graph.
//
// Unit status: secured (1.0) · partial (0.5) · at-risk (0)
// Weight = the unit's risk (1–3), so high-risk knowledge moves the score most.

import { topicName } from "./analyze.js";

const VALUE = { secured: 1, partial: 0.5, "at-risk": 0 };

export const CATEGORY = {
  ownership: "Work they own",
  orphan: "Unowned work",
  conflict: "Disputed decisions",
  recurring: "Repeat problems",
  question: "Unanswered questions",
  unfinished: "Unfinished branches",
  knowledge: "Things only they said",
};

function firstName(n) {
  return (n || "").split(" ")[0].toLowerCase();
}

/**
 * @returns {{ units, score, breakdown, people, leaver }}
 */
export function computeImpact({ claims, conflicts, evidence, leaver }) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const units = [];
  const active = claims.filter((c) => c.status !== "superseded");
  const newOwner = new Map(claims.filter((c) => c.id.startsWith("owner:new:")).map((c) => [c.itemRef, c.person]));
  const authoredByLeaver = (c) => c.citations.some((x) => byId.get(x.evidenceId)?.author === leaver && byId.get(x.evidenceId)?.source !== "testimony");
  const mentionsLeaver = (c) => leaver && new RegExp(`\\b${firstName(leaver)}\\b`, "i").test(c.text);

  // 1. Work the leaver owns -> secured once someone takes it over.
  for (const c of claims.filter((c) => c.type === "owner" && c.leaving)) {
    const to = newOwner.get(c.itemRef);
    units.push({ id: c.id, category: "ownership", label: shortItem(c.item), status: to ? "secured" : "at-risk", weight: 3, claimIds: [c.id, ...(to ? [`owner:new:${c.itemRef}`] : [])], handedTo: to || null, why: to ? `Handed to ${to}` : "Owner is leaving and no successor is named" });
  }
  // 2. Open work nobody owns.
  for (const c of claims.filter((c) => c.type === "owner" && c.missing)) {
    const to = newOwner.get(c.itemRef);
    units.push({ id: c.id, category: "orphan", label: shortItem(c.item), status: to ? "secured" : "at-risk", weight: c.risk, claimIds: [c.id, ...(to ? [`owner:new:${c.itemRef}`] : [])], handedTo: to || null, why: to ? `Assigned to ${to}` : "Nobody owns it" });
  }
  // 3. Disputed decisions (one unit per topic).
  for (const conf of conflicts) {
    units.push({ id: `conflict:${conf.topic}`, category: "conflict", label: topicName(conf.topic), status: conf.resolved ? "secured" : "at-risk", weight: 3, claimIds: conf.claims, why: conf.resolved ? `Confirmed: ${conf.resolved}` : "Sources disagree" });
  }
  // 4. Recurring problems.
  for (const c of active.filter((c) => c.type === "recurring")) {
    units.push({ id: c.id, category: "recurring", label: c.text.match(/“(.+?)”/)?.[1] || "Recurring problem", status: c.confirmed ? "secured" : "partial", weight: c.risk, claimIds: [c.id], why: c.confirmed ? "Fix recorded in interview" : "Pattern known, no permanent fix recorded" });
  }
  // 5. Unanswered questions.
  for (const c of active.filter((c) => c.type === "question")) {
    units.push({ id: c.id, category: "question", label: c.text, status: c.confirmed ? "secured" : "at-risk", weight: Math.max(1, c.risk), claimIds: [c.id], why: c.confirmed ? "Answered in interview" : "No answer in any source" });
  }
  // 6. Idle branches by the leaver (secured if the matching PR was handed over).
  for (const c of active.filter((c) => c.type === "risk" && c.id.startsWith("risk:idle:"))) {
    const ev = byId.get(c.citations[0]?.evidenceId);
    if (!ev || ev.author !== leaver) continue;
    const pr = evidence.find((e) => e.kind === "pr" && e.meta?.branch === ev.meta.branch);
    const to = pr && newOwner.get(pr.id);
    units.push({ id: c.id, category: "unfinished", label: `Branch ${ev.meta.branch}`, status: to ? "secured" : "partial", weight: 2, claimIds: [c.id], handedTo: to || null, why: to ? `Continues with ${to} (${pr.ref})` : "Unfinished, not yet handed over" });
  }
  // 7. Everything else that only the leaver said or wrote.
  const covered = new Set(units.flatMap((u) => u.claimIds));
  for (const c of active.filter((c) => c.status === "active" && !covered.has(c.id) && !c.conflictGroup && !["owner", "question", "recurring", "contact"].includes(c.type))) {
    if (!(authoredByLeaver(c) || mentionsLeaver(c))) continue;
    const st = c.label === "Verified" ? "secured" : c.label === "Conflicting" || c.label === "Missing" ? "at-risk" : "partial";
    units.push({ id: c.id, category: "knowledge", label: clip(c.text, 60), status: st, weight: c.risk || 1, claimIds: [c.id], why: c.label === "Verified" ? "Confirmed by 2+ sources or a person" : "Only one source — and it’s them" });
  }

  const total = units.reduce((s, u) => s + u.weight, 0);
  const got = units.reduce((s, u) => s + u.weight * VALUE[u.status], 0);
  const score = total ? Math.round((got / total) * 100) : 100;
  const breakdown = Object.keys(CATEGORY)
    .map((k) => {
      const us = units.filter((u) => u.category === k);
      return { key: k, name: CATEGORY[k], total: us.length, secured: us.filter((u) => u.status === "secured").length, atRisk: us.filter((u) => u.status === "at-risk").length };
    })
    .filter((b) => b.total);
  const people = [...new Set(units.map((u) => u.handedTo).filter(Boolean))];
  return { units, score, breakdown, people, leaver, counts: { secured: units.filter((u) => u.status === "secured").length, partial: units.filter((u) => u.status === "partial").length, atRisk: units.filter((u) => u.status === "at-risk").length } };
}

function shortItem(s) {
  return clip((s || "").replace(/^(Issue|PR) /, ""), 46);
}
function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/**
 * Deterministic two-sided layout: the leaver in the centre, knowledge units stacked down the left
 * and right (grouped by category, labels pointing outward), new owners between them and the centre.
 */
export function layoutImpact(impact, W = 1000, H = 640) {
  const cx = W / 2, cy = H / 2;
  const order = Object.keys(CATEGORY);
  const units = [...impact.units].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  const half = Math.ceil(units.length / 2);
  const sides = [units.slice(0, half), units.slice(half)];
  const nodes = [{ id: "leaver", kind: "leaver", x: cx, y: cy, label: impact.leaver || "Leaver" }];
  const edges = [];
  sides.forEach((list, s) => {
    const right = s === 0;
    const top = 40, bottom = H - 40;
    const step = list.length > 1 ? (bottom - top) / (list.length - 1) : 0;
    list.forEach((u, j) => {
      const y = list.length > 1 ? top + j * step : cy;
      const x = right ? cx + 255 : cx - 255;
      nodes.push({ id: u.id, kind: "unit", unit: u, x, y, right });
      edges.push({ from: "leaver", to: u.id, status: u.status });
    });
  });
  for (const p of impact.people) {
    const mine = nodes.filter((nd) => nd.kind === "unit" && nd.unit.handedTo === p);
    const rightCount = mine.filter((m) => m.right).length;
    const right = rightCount >= mine.length / 2;
    const ys = mine.filter((m) => m.right === right);
    const y = ys.reduce((a, m) => a + m.y, 0) / (ys.length || 1);
    nodes.push({ id: `person:${p}`, kind: "person", label: p, x: right ? cx + 150 : cx - 150, y: Math.min(H - 24, Math.max(24, y)) });
    for (const m of mine) edges.push({ from: m.id, to: `person:${p}`, status: "handoff" });
  }
  // Spread people that landed on top of each other.
  const ppl = nodes.filter((n) => n.kind === "person").sort((a, b) => a.y - b.y);
  for (let i = 1; i < ppl.length; i++) if (ppl[i].x === ppl[i - 1].x && ppl[i].y - ppl[i - 1].y < 44) ppl[i].y = Math.min(H - 24, ppl[i - 1].y + 44);
  return { nodes, edges, W, H };
}
