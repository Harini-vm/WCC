// Glue: sources -> evidence -> ledger, plus the self-check against Project Lantern ground truth.

import { ingestGithub, ingestDocs, ingestChat } from "./ingest.js";
import { analyze, testimonyEvidence } from "./analyze.js";
import { buildHandover, leakCheck, ROLES } from "./handover.js";

/**
 * sources: { people, github?, docs?, chat?, includePrivate? }
 * returns { evidence, findings, excluded }
 */
export function ingestAll(sources) {
  const findings = [];
  let evidence = [];
  let excluded = [];
  if (sources.github) evidence = evidence.concat(ingestGithub(sources.github, sources.people, findings));
  for (const gh of sources.extraGithub || []) evidence = evidence.concat(ingestGithub(gh, sources.people, findings, { qualify: !!sources.github }));
  if (sources.docs?.length) evidence = evidence.concat(ingestDocs(sources.docs, findings));
  for (const chat of [sources.chat, ...(sources.extraChats || [])].filter(Boolean)) {
    const r = ingestChat(chat, sources.people, { includePrivate: !!sources.includePrivate }, findings);
    evidence = evidence.concat(r.evidence);
    excluded = excluded.concat(r.excluded);
  }
  // De-duplicate ids (e.g. same doc uploaded twice).
  const seen = new Set();
  evidence = evidence.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
  return { evidence, findings, excluded };
}

/** Re-run analysis including testimony from Gap Interview answers. */
export function runAnalysis(baseEvidence, ctx, gapsIndex = {}) {
  const answers = ctx.answers || {};
  const testimony = Object.entries(answers)
    .filter(([, a]) => a && !a.skipped && a.gap)
    .map(([gapId, a]) => testimonyEvidence(a.gap, a, ctx.leaver));
  const evidence = baseEvidence.concat(testimony);
  return { evidence, ...analyze(evidence, ctx) };
}

/** Score the engine against planted traps. Used by the in-app Self-check and the tests. */
export function selfCheck({ claims, conflicts, evidence, reviewsAll, project, truth }) {
  const results = [];
  for (const t of truth.contradictions) {
    const hit = conflicts.some((c) => c.topic === t.topic);
    results.push({ group: "Contradictions flagged", id: t.id, pass: hit, note: t.note });
  }
  for (const t of truth.missingOwners) {
    const hit = claims.some((c) => c.type === "owner" && c.itemRef === `gh:issue:${t.issue}` && (c.missing || c.status === "resolved"));
    results.push({ group: "Missing owners flagged", id: t.id, pass: hit, note: `Issue #${t.issue}` });
  }
  for (const t of truth.recurring) {
    const hit = claims.some((c) => c.type === "recurring" && t.issues.every((n) => c.memberRefs?.includes(`gh:issue:${n}`)));
    results.push({ group: "Recurring problems found", id: t.id, pass: hit, note: t.issues.map((n) => `#${n}`).join(", ") });
  }
  // Leakage: approve EVERYTHING, then check the developer view never contains restricted text.
  const all = reviewsAll || Object.fromEntries(claims.map((c) => [c.id, { status: "approved" }]));
  for (const role of Object.keys(ROLES)) {
    const h = buildHandover({ role, claims, evidence, reviews: all, project });
    const blob = JSON.stringify(h.list.map((c) => [c.text, c.citations.map((x) => evidence.find((e) => e.id === x.evidenceId)?.text)]));
    const lc = leakCheck(h, evidence);
    for (const t of truth.leaks) {
      if (role === "lead" && t.id === "budget") continue; // leads may see the budget
      // Secrets and private DMs must not exist anywhere in stored evidence; the budget must not reach a developer.
      const stored = t.id !== "budget" && JSON.stringify(evidence).includes(t.needle);
      const leaked = blob.includes(t.needle) || stored;
      results.push({ group: `No leaks in ${ROLES[role].name} view`, id: `${role}:${t.id}`, pass: !leaked && lc.ok, note: t.kind });
    }
  }
  const citations = claims.flatMap((c) => c.citations);
  const exact = citations.filter((cit) => evidence.find((e) => e.id === cit.evidenceId)?.text.includes(cit.quote)).length;
  return { results, citationIntegrity: { exact, total: citations.length } };
}
