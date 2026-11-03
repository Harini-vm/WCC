// Run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { LANTERN } from "../data/lantern.js";
import { LANTERN_TRUTH } from "../data/lantern-truth.js";
import { ingestAll, runAnalysis, selfCheck } from "../js/engine/pipeline.js";
import { redact } from "../js/engine/redact.js";
import { parseUpload, fetchGithubRepo } from "../js/engine/ingest.js";
import { choiceOf } from "../js/engine/analyze.js";
import { buildHandover, leakCheck, ask } from "../js/engine/handover.js";
import { sentences } from "../js/engine/util.js";

const L = LANTERN;
const base = () => ingestAll({ people: L.people, github: L.github, docs: L.docs, chat: L.chat });
const ctx = (answers = {}) => ({ leaver: L.project.leaver, today: L.project.today, people: L.people, answers });

test("all 12 planted traps are handled (self-check passes)", () => {
  const r = runAnalysis(base().evidence, ctx());
  const sc = selfCheck({ ...r, project: L.project, truth: LANTERN_TRUTH });
  const failed = sc.results.filter((x) => !x.pass);
  assert.deepEqual(failed, []);
  assert.equal(sc.citationIntegrity.exact, sc.citationIntegrity.total);
});

test("every citation quote exists word-for-word in its evidence", () => {
  const r = runAnalysis(base().evidence, ctx());
  const byId = new Map(r.evidence.map((e) => [e.id, e]));
  for (const c of r.claims) {
    assert.ok(c.citations.length > 0, `claim without citation: ${c.text}`);
    for (const cit of c.citations) assert.ok(byId.get(cit.evidenceId).text.includes(cit.quote), cit.quote);
  }
});

test("secrets are removed before storage; private DMs are excluded", () => {
  const { evidence, findings, excluded } = base();
  const blob = JSON.stringify(evidence);
  assert.ok(!blob.includes("SG.k9Xq2"));
  assert.ok(!blob.includes("Sneha"));
  assert.ok(!blob.includes("lakshmi.events@"));
  assert.ok(findings.some((f) => f.name === "SendGrid API key"));
  assert.deepEqual(excluded.map((x) => x.channel), ["dm-arjun-priya"]);
});

test("redaction does not mangle dates or ordinary numbers", () => {
  const r = redact("Launch on 2026-11-29, Rs 45,000, issue #88, call +91 98765 43210, key sk-abcdefghijklmnopqrstuvwx");
  assert.ok(r.text.includes("2026-11-29"));
  assert.ok(r.text.includes("45,000"));
  assert.ok(r.text.includes("[phone masked]"));
  assert.ok(r.text.includes("[secret removed]"));
});

test("a developer never sees leads-only material, even if everything is approved", () => {
  const r = runAnalysis(base().evidence, ctx());
  const all = Object.fromEntries(r.claims.map((c) => [c.id, { status: "approved" }]));
  const dev = buildHandover({ role: "developer", claims: r.claims, evidence: r.evidence, reviews: all, project: L.project });
  const lead = buildHandover({ role: "lead", claims: r.claims, evidence: r.evidence, reviews: all, project: L.project });
  assert.ok(leakCheck(dev, r.evidence).ok);
  assert.ok(!JSON.stringify(dev.list).includes("45,000"));
  assert.ok(JSON.stringify(lead.list).includes("45,000"));
  assert.ok(dev.hiddenForPermissions > 0);
  assert.equal(ask("What is the budget?", dev, all).matches.length, 0);
  assert.ok(ask("What is the budget?", lead, all).matches.length > 0);
});

test("unapproved claims never reach the handover", () => {
  const r = runAnalysis(base().evidence, ctx());
  const h = buildHandover({ role: "lead", claims: r.claims, evidence: r.evidence, reviews: {}, project: L.project });
  assert.equal(h.list.length, 0);
});

test("a gap-interview answer resolves a conflict and is cited as testimony", () => {
  const first = runAnalysis(base().evidence, ctx());
  const gap = first.gaps.find((g) => g.id === "gap:conflict:launch");
  assert.ok(gap, "launch conflict gap exists");
  const answers = { [gap.id]: { gap, choice: "29 Nov 2026", text: "Venue clash.", at: "2026-10-30" } };
  const r = runAnalysis(base().evidence, ctx(answers));
  const conf = r.conflicts.find((c) => c.topic === "launch");
  assert.equal(conf.resolved, "29 Nov 2026");
  const chosen = r.claims.find((c) => c.topic === "launch" && c.choice === "29 Nov 2026");
  assert.equal(chosen.label, "Verified");
  assert.ok(chosen.citations.some((c) => c.evidenceId === "testimony:gap:conflict:launch"));
  const old = r.claims.find((c) => c.topic === "launch" && c.choice === "15 Nov 2026");
  assert.equal(old.status, "superseded");
});

test("assigning an owner in the interview creates a new verified owner claim", () => {
  const first = runAnalysis(base().evidence, ctx());
  const gap = first.gaps.find((g) => g.id === "gap:owner:gh:issue:80");
  const r = runAnalysis(base().evidence, ctx({ [gap.id]: { gap, owner: "Priya Nair", text: "", at: "2026-10-30" } }));
  const c = r.claims.find((x) => x.id === "owner:new:gh:issue:80");
  assert.equal(c.person, "Priya Nair");
  assert.equal(c.label, "Verified");
  assert.equal(r.claims.find((x) => x.id === "owner:missing:gh:issue:80").status, "resolved");
});

test("skipping a gap keeps the claim Missing", () => {
  const first = runAnalysis(base().evidence, ctx());
  const gap = first.gaps.find((g) => g.id === "gap:owner:gh:issue:81");
  const r = runAnalysis(base().evidence, ctx({ [gap.id]: { gap, skipped: true, at: "2026-10-30" } }));
  assert.equal(r.claims.find((x) => x.id === "owner:missing:gh:issue:81").label, "Missing");
  assert.equal(r.gaps.find((g) => g.id === gap.id).status, "skipped");
});

test("claim ids are stable across re-analysis (review state survives)", () => {
  const a = runAnalysis(base().evidence, ctx()).claims.map((c) => c.id).sort();
  const b = runAnalysis(base().evidence, ctx()).claims.map((c) => c.id).sort();
  assert.deepEqual(a, b);
});

test("choice extraction", () => {
  assert.equal(choiceOf("Switch auth from Firebase to Supabase.", "auth"), "Supabase");
  assert.equal(choiceOf("We moved hosting to Netlify because the Vercel build minutes ran out.", "hosting"), "Netlify");
  assert.equal(choiceOf("Auth stays on Firebase until the app ships.", "auth"), "Firebase");
  assert.equal(choiceOf("Launch moved to 29 Nov 2026 because of the venue.", "launch"), "29 Nov 2026");
});

test("sentence splitting keeps exact substrings and abbreviations", () => {
  const t = "Contact Ms. Lakshmi first. Then call Rahul? Yes.";
  const s = sentences(t);
  assert.equal(s[0], "Contact Ms. Lakshmi first.");
  for (const x of s) assert.ok(t.includes(x));
});

test("uploads: markdown doc, JSON chat array, WhatsApp text", () => {
  assert.equal(parseUpload("notes.md", "# Notes\n- Decision: use Stripe", "leads").kind, "doc");
  const chat = parseUpload("dev.json", JSON.stringify([{ user: "a", ts: "2026-10-01", text: "hi" }]));
  assert.equal(chat.kind, "chat");
  const wa = parseUpload("group.txt", "12/10/2026, 18:00 - Priya: Launch moved\n13/10/2026, 09:00 - Karthik: ok");
  assert.equal(wa.kind, "chat");
  assert.equal(wa.value.channels[0].messages[0].ts, "2026-10-12");
  assert.throws(() => parseUpload("x.pdf", "..."));
});

test("live GitHub import maps the REST API shape (mocked network)", async () => {
  const fake = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes("/pulls") ? [{ number: 1, title: "Use Stripe for checkout", state: "closed", merged_at: "2026-10-01T00:00:00Z", user: { login: "x" }, body: "" }]
      : url.includes("/issues") ? [{ number: 2, title: "Login broken", state: "open", user: { login: "y" }, assignee: null, labels: [], body: "", created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" }, { number: 1, pull_request: {} }]
      : url.includes("/branches") ? [{ name: "main", commit: { url: "c1" } }, { name: "wip", commit: { url: "c2" } }]
      : { commit: { committer: { date: "2026-09-01T00:00:00Z" } }, author: { login: "y" } },
  });
  const gh = await fetchGithubRepo("https://github.com/acme/app", fake);
  assert.equal(gh.repo, "acme/app");
  assert.equal(gh.branches.length, 1);
  const ing = ingestAll({ people: [], github: gh });
  assert.equal(ing.evidence.filter((e) => e.kind === "issue").length, 1);
  const r = runAnalysis(ing.evidence, { leaver: "x", today: "2026-10-30", people: [], answers: {} });
  assert.ok(r.claims.some((c) => c.type === "owner" && c.missing));
  assert.ok(r.claims.some((c) => c.type === "risk" && /wip/.test(c.text)));
});

test("exit impact: readiness score rises as the leaver closes gaps", async () => {
  const { computeImpact, layoutImpact } = await import("../js/engine/impact.js");
  const first = runAnalysis(base().evidence, ctx());
  const before = computeImpact({ ...first, leaver: L.project.leaver });
  assert.ok(before.score < 40, `baseline ${before.score}`);
  assert.equal(before.units.filter((u) => u.category === "conflict").length, 4);
  assert.equal(before.units.filter((u) => u.category === "ownership").length, 4);
  const answers = {};
  for (const g of first.gaps) {
    if (g.type === "conflict") answers[g.id] = { gap: g, choice: g.options[1], text: "", at: "2026-10-30" };
    else if (g.type === "owner" || g.type === "handoff") answers[g.id] = { gap: g, owner: "Karthik R", text: "", at: "2026-10-30" };
    else answers[g.id] = { gap: g, text: "Answered.", at: "2026-10-30" };
  }
  const after = computeImpact({ ...runAnalysis(base().evidence, ctx(answers)), leaver: L.project.leaver });
  assert.ok(after.score > before.score + 50, `${before.score} -> ${after.score}`);
  assert.equal(after.counts.atRisk, 0);
  assert.deepEqual(after.people, ["Karthik R"]);
  const lay = layoutImpact(after);
  for (const n of lay.nodes) assert.ok(n.x >= 0 && n.x <= lay.W && n.y >= 0 && n.y <= lay.H, `node ${n.id} off canvas`);
});

test("a second repository never overwrites the first (same issue numbers)", () => {
  const other = { repo: "acme/other", pulls: [], branches: [], issues: [{ number: 80, title: "Different issue", state: "open", user: { login: "z" }, assignee: null, labels: [], body: "", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }] };
  const ing = ingestAll({ people: L.people, github: L.github, extraGithub: [other] });
  assert.ok(ing.evidence.some((e) => e.id === "gh:issue:80" && /Venue/.test(e.title)));
  assert.ok(ing.evidence.some((e) => e.id === "gh:acme/other:issue:80" && e.ref === "acme/other Issue #80"));
});

test("URLs and file names never split sentences or become fake questions", () => {
  const t = "Download it from https://drive.google.com/file/d/abc/view?usp=sharing and run app.py. Then deploy v1.2.";
  const s = sentences(t);
  assert.equal(s.length, 2);
  assert.ok(s[0].includes("view?usp=sharing and run app.py."));
  const ev = [{ id: "doc:r:1", source: "docs", kind: "doc", ref: "README", text: "Model: https://drive.google.com/file/d/x/view?usp=sharing", date: "2026-10-01", visibility: "team", meta: {} }];
  const r = runAnalysis(ev, { leaver: "x", today: "2026-11-03", people: [], answers: {} });
  assert.equal(r.claims.filter((c) => c.type === "question").length, 0);
});

test("a repo with only commits still produces a handover (no issues or PRs)", async () => {
  const commits = ["Add login page", "Fix login crash on submit", "Fix login crash when password empty", "Write README"].map((m, i) => ({ sha: `abc${i}def0`, commit: { message: m, author: { name: "Asha", date: `2026-10-0${i + 1}T00:00:00Z` } }, author: { login: "asha" } }));
  const ing = ingestAll({ people: [], github: { repo: "a/b", pulls: [], issues: [], branches: [], commits, docs: [{ path: "README.md", body: "# B\n![badge](x.svg)\n```\nnpm i\n```\nDecision: Use Supabase for auth.", modified: "2026-10-05" }] } });
  assert.ok(ing.evidence.some((e) => e.kind === "commit"));
  assert.ok(!ing.evidence.some((e) => /npm i|badge/.test(e.text)), "code fences and badges skipped");
  const r = runAnalysis(ing.evidence, { leaver: "asha", today: "2026-11-03", people: [], answers: {} });
  assert.ok(r.claims.some((c) => c.id === "risk:concentration"));
  assert.ok(r.claims.some((c) => c.type === "recurring" && c.citations.length >= 2), "repeated fix commits cluster");
  assert.ok(r.claims.some((c) => c.type === "decision" && c.choice === "Supabase"));
});

// ---- Round 1 commitments: share link, effort, readiness check, spot-check, rejected options ----
const approveAll = (r) => Object.fromEntries(r.claims.map((c) => [c.id, { status: "approved" }]));
function answeredRun() {
  const first = runAnalysis(base().evidence, ctx());
  const g = first.gaps.find((x) => x.id === "gap:conflict:launch");
  return runAnalysis(base().evidence, ctx({ [g.id]: { gap: g, choice: "29 Nov 2026", text: "", at: "2026-10-30" } }));
}

test("rejected options stay in the timeline, struck through, after a conflict is resolved", () => {
  const r = answeredRun();
  const h = buildHandover({ role: "developer", claims: r.claims, evidence: r.evidence, reviews: approveAll(r), project: L.project });
  const rej = h.sections.rejected;
  assert.equal(rej.length, 1);
  assert.equal(rej[0].choice, "15 Nov 2026");
  assert.ok(h.sections.timeline.some((c) => c.rejected));
});

test("share link carries only what the role may see, and round-trips", async () => {
  const { sharePayload, encodeShare, decodeShare } = await import("../js/share.js");
  const r = answeredRun();
  const reviews = approveAll(r);
  const dev = buildHandover({ role: "developer", claims: r.claims, evidence: r.evidence, reviews, project: L.project });
  const payload = sharePayload({ ho: dev, evidence: r.evidence, reviews, project: L.project, version: { n: 1, by: "Priya Nair", at: "2026-10-30T00:00:00Z" } });
  const blob = JSON.stringify(payload);
  assert.ok(!blob.includes("45,000") && !blob.includes("Sneha") && !blob.includes("SG.k9Xq2"));
  assert.ok(payload.evidence.every((e) => e.visibility === "team"));
  const token = await encodeShare(payload);
  assert.ok(token.length < blob.length, "compressed");
  const back = await decodeShare(token);
  assert.deepEqual(back.claims.map((c) => c.id), payload.claims.map((c) => c.id));
  const again = buildHandover({ role: back.role, claims: back.claims, evidence: back.evidence, reviews: back.reviews, project: back.project });
  assert.equal(again.list.length, dev.list.length);
  await assert.rejects(decodeShare("z.notvalid"));
});

test("readiness check: questions come from the approved view and have one right answer", async () => {
  const { buildQuiz, scoreQuiz } = await import("../js/engine/extras.js");
  const r = runAnalysis(base().evidence, ctx());
  const reviews = approveAll(r);
  const dev = buildHandover({ role: "developer", claims: r.claims, evidence: r.evidence, reviews, project: L.project });
  const qs = buildQuiz(dev, reviews);
  assert.equal(qs.length, 10);
  for (const q of qs) {
    assert.ok(q.options.includes(q.answer));
    assert.equal(new Set(q.options).size, q.options.length);
    assert.ok(dev.list.some((c) => c.id === q.claimId), "every question is backed by a visible claim");
  }
  assert.ok(qs.some((q) => q.kind === "uncertainty"), "tests whether the successor notices conflicts");
  assert.ok(!JSON.stringify(qs).includes("45,000"));
  const perfect = Object.fromEntries(qs.map((q) => [q.id, q.answer]));
  assert.equal(scoreQuiz(qs, perfect).right, 10);
});

test("citation spot-check sampling and accuracy", async () => {
  const { sampleCitations, spotAccuracy, citationUnits } = await import("../js/engine/extras.js");
  const r = runAnalysis(base().evidence, ctx());
  const s1 = sampleCitations(r.claims, {}, 5, 1);
  assert.equal(s1.length, 5);
  const checked = Object.fromEntries(s1.map((u, i) => [u.key, i === 0 ? "no" : "yes"]));
  const s2 = sampleCitations(r.claims, checked, 5, 1);
  assert.ok(s2.every((u) => !(u.key in checked)), "never re-asks a checked citation");
  assert.deepEqual(spotAccuracy(checked), { checked: 5, yes: 4, pct: 80 });
  assert.ok(citationUnits(r.claims).length >= 40);
});

test("leaver effort counts active time and caps long pauses", async () => {
  const { addEffort } = await import("../js/engine/extras.js");
  let it = addEffort({}, 0);
  it = addEffort(it, 60_000);
  it = addEffort(it, 60_000 + 60 * 60_000);
  assert.equal(it.activeMs, 60_000 + 5 * 60_000);
  assert.equal(it.actions, 2);
});

// ---- AI extraction ----
test("AI: training and test sentences never overlap", async () => {
  const { TRAIN } = await import("../data/ml-train.js");
  const { TEST } = await import("../data/ml-test.js");
  const tr = new Set(TRAIN.map(([s]) => s.toLowerCase()));
  assert.equal(TEST.filter(([s]) => tr.has(s.toLowerCase())).length, 0);
  const demo = JSON.stringify(L).toLowerCase();
  assert.equal(TRAIN.filter(([s]) => demo.includes(s.toLowerCase().slice(0, 40))).length, 0, "no demo sentences in training");
});

test("AI: rules + AI clearly beat rules alone on the held-out set, without losing precision", async () => {
  const { evaluate } = await import("../js/engine/eval.js");
  const { TEST } = await import("../data/ml-test.js");
  const r = evaluate(TEST);
  assert.ok(r.combined.micro.f1 > r.rules.micro.f1 + 0.3, `${r.rules.micro.f1} -> ${r.combined.micro.f1}`);
  assert.ok(r.combined.micro.precision >= 0.9);
  assert.ok(r.aiVerified.micro.precision >= r.aiUnverified.micro.precision, "the second model's agreement means something");
});

test("AI: claims keep exact quotes, are labelled Inferred, and never duplicate rule claims", () => {
  const off = runAnalysis(base().evidence, ctx());
  const on = runAnalysis(base().evidence, { ...ctx(), ai: "local" });
  const ai = on.claims.filter((c) => c.basis === "ai");
  assert.ok(ai.length >= 1);
  const byId = new Map(on.evidence.map((e) => [e.id, e]));
  for (const c of ai) {
    assert.equal(c.label === "Missing" ? "question" : c.label, c.label === "Missing" ? c.type : "Inferred");
    assert.ok(byId.get(c.citations[0].evidenceId).text.includes(c.citations[0].quote));
    assert.ok(!off.claims.some((o) => o.citations.some((x) => x.quote === c.citations[0].quote && x.evidenceId === c.citations[0].evidenceId)));
  }
  assert.equal(on.stats.ai.accepted, ai.length);
  const sc = selfCheck({ ...on, project: L.project, truth: LANTERN_TRUTH });
  assert.deepEqual(sc.results.filter((x) => !x.pass), [], "AI does not break any trap check or leak check");
});

test("AI: Claude labels are parsed, checked locally, and errors are clear (mocked network)", async () => {
  const { labelWithClaude, parseLabels } = await import("../js/engine/llm.js");
  assert.deepEqual(parseLabels('Sure: [{"i":1,"label":"risk"},{"i":2,"label":"bogus"}]', 2), ["risk", "none"]);
  let sent;
  const ok = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '[{"i":1,"label":"risk"},{"i":2,"label":"decision"}]' }] }) };
  };
  const labels = await labelWithClaude(["The server melts on fest day.", "We went with Neon."], { apiKey: "sk-ant-test", fetchImpl: ok });
  assert.deepEqual(labels, ["risk", "decision"]);
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(labelWithClaude(["x y z w"], { apiKey: "sk-ant-bad", fetchImpl: denied }), /rejected/);
  await assert.rejects(labelWithClaude(["x"], { apiKey: "" }), /API key/);
  const first = runAnalysis(base().evidence, ctx());
  const target = first.evidence.find((e) => e.id === "gh:pr:70");
  const sentence = "Session refresh works on web; the mobile app is not started.";
  const r = runAnalysis(base().evidence, { ...ctx(), ai: "claude", llm: { [`${target.id}|${sentence}`]: "risk" } });
  const c = r.claims.find((x) => x.basis === "ai");
  assert.equal(c.ai.by, "Claude");
  assert.equal(c.type, "risk");
});
