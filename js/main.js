// Baton UI. Plain ES modules, no framework, no build step.
import { demoState, customState, load, save, today } from "./store.js";
import { ingestAll, runAnalysis, selfCheck } from "./engine/pipeline.js";
import { parseUpload, fetchGithubRepo, VISIBILITY } from "./engine/ingest.js";
import { TYPES, LABELS, topicName, riskName } from "./engine/analyze.js";
import { ROLES, buildHandover, leakCheck, ask, toMarkdown } from "./engine/handover.js";
import { LANTERN_TRUTH } from "../data/lantern-truth.js";
import { computeImpact, layoutImpact, CATEGORY } from "./engine/impact.js";
import { buildQuiz, scoreQuiz, sampleCitations, spotAccuracy, addEffort, fmtDuration } from "./engine/extras.js";
import { encodeShare, decodeShare, sharePayload } from "./share.js";
import { registerTopicName, ruleTypeOf } from "./engine/analyze.js";
import { classify, ML_LABELS } from "./engine/ml.js";
import { MODEL } from "./engine/ml-model.js";
import { evaluate } from "./engine/eval.js";
import { labelWithClaude } from "./engine/llm.js";
import { TEST } from "../data/ml-test.js";
import { sentences as splitSentences } from "./engine/util.js";
import { escapeHtml as h, prettyDate } from "./engine/util.js";

let state = load();
let D = null; // derived: { evidence, findings, excluded, claims, conflicts, gaps, stats, byId }
const ui = { label: "all", type: "all", q: "", tab: "gaps", role: "developer", editing: null, askQ: "", askRes: null, busy: false, revFilter: "pending" };

// Shared read-only view (#/view?d=…): decoded payload, used instead of the local project.
let VD = null;
let viewing = false;
function cx() {
  return viewing && VD ? VD : { byId: D?.byId || new Map(), claims: D?.claims || [], reviews: state?.reviews || {} };
}

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

/* ---------- derive ---------- */
function derive() {
  if (!state) return (D = null);
  const t0 = performance.now();
  const ing = ingestAll({ people: state.people, ...state.sources });
  const aiMode = state.aiMode ?? "local";
  const ctx = { leaver: state.project.leaver, today: state.project.today || today(), people: state.people, answers: state.answers, ai: aiMode === "claude" && !state.llm ? "local" : aiMode, llm: state.llm?.labels };
  const res = runAnalysis(ing.evidence, ctx);
  D = { ...ing, ...res, byId: new Map(res.evidence.map((e) => [e.id, e])), ms: Math.round(performance.now() - t0) };
  D.impact = computeImpact({ claims: res.claims, conflicts: res.conflicts, evidence: res.evidence, leaver: state.project.leaver });
  // Baseline = the same project with no interview answers: what the successor would inherit today.
  const base = Object.keys(state.answers).length ? runAnalysis(ing.evidence, { ...ctx, answers: {} }) : res;
  D.baseline = Object.keys(state.answers).length ? computeImpact({ claims: base.claims, conflicts: base.conflicts, evidence: base.evidence, leaver: state.project.leaver }).score : D.impact.score;
}
function commit(auditEntry) {
  if (auditEntry) state.audit.push({ at: new Date().toISOString(), ...auditEntry });
  save(state);
  derive();
  render();
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- small renderers ---------- */
const LABEL_CLASS = { Verified: "b-verified", "Single-source": "b-single", Inferred: "b-inferred", Conflicting: "b-conflicting", Missing: "b-missing" };
const LABEL_HELP = {
  Verified: "Two or more independent sources agree, or a person confirmed it",
  "Single-source": "One source supports it — check that source",
  Inferred: "Found by a pattern (e.g. similar issues, idle branch) — an assumption, not a fact",
  Conflicting: "Sources disagree — both sides are shown",
  Missing: "Expected but not in the evidence — becomes a gap question",
};
const badge = (label) => `<span class="badge ${LABEL_CLASS[label] || ""}" title="${h(LABEL_HELP[label] || "")}">${h(label)}</span>`;
const SRC = { github: "GitHub", docs: "Docs", chat: "Chat", testimony: "Interview" };

function chips(c) {
  const seen = new Set();
  return c.citations
    .filter((x) => (seen.has(x.evidenceId) ? false : seen.add(x.evidenceId)))
    .map((x) => {
      const e = cx().byId.get(x.evidenceId);
      if (!e) return "";
      return `<button class="chip" data-act="ev" data-id="${h(e.id)}" data-claim="${h(c.id)}" title="Open source"><span class="src">${SRC[e.source] || e.source}</span>${h(e.ref)}</button>`;
    })
    .join("");
}

function claimText(c) {
  return cx().reviews[c.id]?.text || c.text;
}

function claimCard(c, opt = {}) {
  const r = opt.review ? state.reviews[c.id] : null;
  const status = c.status !== "active" ? `<span class="badge ${c.status === "superseded" ? "b-superseded" : "b-resolved"}">${c.status === "superseded" ? "Superseded by " + h(c.supersededBy) : "Resolved in interview"}</span>` : "";
  const extra = [];
  if (c.answer) extra.push(`<b>Answer (testimony):</b> ${h(c.answer)}`);
  if (c.fix) extra.push(`<b>Fix (testimony):</b> ${h(c.fix)}`);
  if (c.done) extra.push(`Marked done: a later update reports this as finished.`);
  if (r?.edited) extra.push(`<span class="muted small">Edited by reviewer. Original: “${h(c.text)}”</span>`);
  let review = "";
  if (opt.review && c.status === "active") {
    if (ui.editing === c.id) {
      review = `<div class="review" style="flex-direction:column;align-items:stretch"><textarea id="edit-${h(c.id)}" aria-label="Edit claim text">${h(claimText(c))}</textarea>
        <div class="row"><button class="btn sm ok" data-act="save-edit" data-id="${h(c.id)}">Save and approve</button><button class="btn sm ghost" data-act="cancel-edit">Cancel</button></div></div>`;
    } else {
      const st = r?.status || "pending";
      review = `<div class="review"><span class="tag">Review: ${st === "approved" ? '<span class="pass">approved</span>' : st === "rejected" ? '<span class="fail">rejected</span>' : "pending"}</span>
        <span style="flex:1"></span>
        ${st !== "approved" ? `<button class="btn sm ok" data-act="approve" data-id="${h(c.id)}">Approve</button>` : ""}
        <button class="btn sm ghost" data-act="edit" data-id="${h(c.id)}">Edit</button>
        ${st !== "rejected" ? `<button class="btn sm no" data-act="reject" data-id="${h(c.id)}">Reject</button>` : ""}
        ${st !== "pending" ? `<button class="btn sm ghost" data-act="unreview" data-id="${h(c.id)}">Undo</button>` : ""}</div>`;
    }
  }
  return `<article class="claim l-${h(c.label)} st-${h(c.status)} ${r ? "rev-" + r.status : ""}" id="c-${h(c.id)}">
    <div class="meta">${badge(c.label)}<span class="tag">${h(TYPES[c.type] || c.type)}${c.topic ? " · " + h(topicName(c.topic)) : ""}</span>${c.risk >= 3 && c.status === "active" ? `<span class="tag risk-3">High risk</span>` : ""}${status}</div>
    <div class="text">${h(claimText(c))}</div>
    ${extra.length ? `<div class="extra">${extra.join("<br>")}</div>` : ""}
    ${c.ai ? `<div class="aitag" title="Found by AI, not by a rule. Labelled Inferred until a person approves it.">✦ Found by AI (${h(c.ai.by)}, ${Math.round(c.ai.p * 100)}% sure) · ${c.ai.verified ? `<span class="pass">second model agrees</span>` : `<span class="fail">second model disagrees (said ${h(c.ai.second)}) — check carefully</span>`}</div>` : ""}
    <div class="cites">${chips(c)}</div>
    ${review}
  </article>`;
}

/* ---------- chrome ---------- */
const STEPS = [
  ["connect", "Connect"],
  ["reconstruct", "Reconstruct"],
  ["verify", "Verify"],
  ["review", "Review"],
  ["handover", "Handover"],
];
function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  return { path: path || "", params };
}
function stepDone(id) {
  if (!state) return false;
  if (["connect", "reconstruct", "verify"].includes(id)) return state.connected;
  if (id === "review") return state.versions.length > 0;
  if (id === "handover") return state.acks.length > 0;
}
function renderChrome(path) {
  const steps = $("#steps");
  if (path === "view") {
    steps.innerHTML = "";
    $("#tools").innerHTML = `<a href="#/">Open Baton</a>`;
    $("#rolebar").hidden = false;
    $("#rolebar").innerHTML = `<div>You are reading a <b>shared, read-only handover</b>. It contains only approved claims from sources your role may see.</div>`;
    return;
  }
  steps.innerHTML = state
    ? STEPS.map(([id, name], i) => `<a class="step ${stepDone(id) ? "done" : ""}" href="#/${id}" ${path === id ? 'aria-current="step"' : ""}><span class="n">${stepDone(id) && path !== id ? "✓" : i + 1}</span><span class="label">${name}</span></a>`).join("")
    : "";
  $("#tools").innerHTML = state
    ? `${state.connected ? `<a href="#/impact" class="hot">Impact map · ${D.impact.score}</a>` : ""}${state.connected ? `<a href="#/ai">AI vs rules</a>` : ""}${state.kind === "demo" ? `<a href="#/check">Self-check</a>` : ""}<button data-act="reset" title="Clear this project from your browser">${state.kind === "demo" ? "Reset demo" : "Close project"}</button>`
    : `<a href="https://github.com/" id="repo-link" hidden>Code</a>`;
  const rb = $("#rolebar");
  if (!state) {
    rb.hidden = true;
    return;
  }
  const acting = {
    connect: `You are the <b>team lead</b> deciding which sources Baton may read. Nothing is shared at this stage.`,
    reconstruct: `Baton has rebuilt the project from the connected sources. <b>Nothing here is shared yet.</b> Click any source chip to see the exact text behind a claim.`,
    verify: `Every claim is checked against its source. Labels come from the evidence, not from the software’s own confidence.`,
    review: ui.tab === "gaps" ? `You are <b>${h(state.project.leaver || "the person leaving")}</b>. Answer only the questions the evidence can’t — your answers are saved as signed testimony.` : `You are <b>${h(state.reviewer)}</b>, the reviewer. Nothing reaches the successor until you approve a version.`,
    handover: `You are the <b>successor</b>. You see only approved claims from sources your role is allowed to read.`,
    impact: `Everything tied to <b>${h(state.project.leaver || "the leaver")}</b> that leaves on ${prettyDate(state.project.exitDate)} — and how much of it is secured. The score updates live as gaps are closed.`,
    ai: `How much the AI adds over the rules, measured on ${TEST.length} sentences the model never saw in training.`,
    check: `Self-check scores Baton against the 12 traps planted in the demo data.`,
  }[path];
  rb.hidden = !acting;
  rb.innerHTML = acting ? `<div>${acting}</div>` : "";
}

/* ---------- pages ---------- */
function pageHome() {
  return `
  <section class="hero">
    <div>
      <p class="eyebrow">Knowledge handover · Team FlyHigh</p>
      <h1 style="margin-top:10px">Handovers that prove themselves.</h1>
      <p class="lede">When someone leaves a project, Baton rebuilds what they knew from the project’s own GitHub, docs and chat. Every line links to its source, every doubt is labelled, the person leaving answers only the gaps — and each successor sees only what they’re allowed to.</p>
      <div class="row" style="margin-top:22px">
        <button class="btn amber" data-act="demo">Try the demo project →</button>
        <button class="btn ghost" data-act="custom">Use your own sources</button>
      </div>
      <p class="small muted" style="margin-top:12px">Runs entirely in your browser. Nothing you load is sent to a server.</p>
    </div>
    <div class="card dark">
      <p class="eyebrow" style="color:var(--amber)">Demo: Project Lantern</p>
      <h3 style="margin-top:8px">A student club’s ticketing app. Its tech lead, Arjun, leaves on 31 Oct.</h3>
      <p style="margin-top:10px;color:#d9dee6">Synthetic data: 5 pull requests, 9 issues, 3 branches, 5 docs and 3 chat channels — with 12 traps planted:</p>
      <ul style="margin:10px 0 0;padding-left:18px;color:#d9dee6">
        <li>4 contradictions between sources</li>
        <li>3 tasks nobody owns</li>
        <li>2 problems that keep coming back</li>
        <li>1 API key pasted in chat, 1 private DM, 1 leads-only budget</li>
      </ul>
    </div>
  </section>
  <section class="section">
    <h2>Five steps</h2>
    <div class="flow">
      ${[
        ["01", "Connect", "Choose which sources Baton may read. Private DMs are excluded, secrets are removed on arrival."],
        ["02", "Reconstruct", "Decisions, owners, risks, dependencies, open questions and a timeline — each with an exact quote."],
        ["03", "Verify", "Each quote is checked against its source. Conflicts are put side by side, never smoothed over."],
        ["04", "Review", "The leaver answers only the gaps. A reviewer approves, edits or rejects every claim."],
        ["05", "Handover", "A role-filtered handover with a first-72-hours plan, Q&A and receipt."],
      ]
        .map(([n, t, d]) => `<div class="card flat"><p class="n">${n}</p><h3 style="margin-top:4px">${t}</h3><p class="small muted" style="margin-top:6px">${d}</p></div>`)
        .join("")}
    </div>
  </section>
  <section class="section grid g3">
    <div class="card flat"><h3>No citation, no claim</h3><p class="muted" style="margin-top:6px">A statement only exists if its quote is found word-for-word in a source.</p></div>
    <div class="card flat"><h3>Honest labels</h3><p class="muted" style="margin-top:6px">${LABELS.map(badge).join(" ")}</p></div>
    <div class="card flat"><h3>It can’t leak what it never shows</h3><p class="muted" style="margin-top:6px">A claim reaches a role only if every source it cites is visible to that role.</p></div>
  </section>`;
}

function pageConnect() {
  const s = state.sources;
  const people = peopleOptions();
  const gh = [s.github, ...(s.extraGithub || [])].filter(Boolean);
  const chats = [s.chat, ...(s.extraChats || [])].filter(Boolean);
  const secrets = D.findings.filter((f) => f.kind === "secret");
  const personal = D.findings.filter((f) => f.kind === "personal");
  return `
  <div class="page-head"><div><p class="eyebrow">Step 1 of 5</p><h1 style="font-size:36px;margin-top:6px">Connect authorised sources</h1>
  <p class="lede">Pick what Baton may read and who may see it. Visibility travels with every piece of evidence, all the way to the handover.</p></div>
  <button class="btn amber" data-act="go-reconstruct" ${D.evidence.length ? "" : "disabled"}>Reconstruct the project →</button></div>

  <div class="card flat"><div class="grid g3">
    <label class="field">Project name<input data-act="proj" data-k="name" value="${h(state.project.name)}"></label>
    <label class="field">Who is leaving?<input data-act="proj" data-k="leaver" list="people-list" value="${h(state.project.leaver)}" placeholder="Name as it appears in the sources"><datalist id="people-list">${people.map((p) => `<option value="${h(p)}">`).join("")}</datalist></label>
    <label class="field">Last day<input type="date" data-act="proj" data-k="exitDate" value="${h(state.project.exitDate || "")}"></label>
  </div></div>

  <div class="grid g3 section">
    <div class="card">
      <div class="row between"><h3>GitHub</h3><span class="tag">${gh.length ? "connected" : "not connected"}</span></div>
      ${gh.map((g) => `<p class="small" style="margin-top:8px"><b>${h(g.repo)}</b> · ${(g.pulls || []).length} PRs · ${(g.issues || []).filter((i) => !i.pull_request).length} issues · ${(g.branches || []).length} side branches${g.commits ? ` · ${g.commits.length} commits · ${(g.docs || []).length} Markdown files` : ""} <span class="vis">team</span></p>${g.docs?.length ? `<p class="small muted">Docs: ${g.docs.map((d) => h(d.path)).join(", ")}</p>` : ""}`).join("") || `<p class="muted small" style="margin-top:8px">No repository yet.</p>`}
      <hr class="sep">
      <label class="field">Import a public repository (live, GitHub API)
        <div class="row" style="flex-wrap:nowrap"><input id="gh-repo" placeholder="owner/repo, e.g. vercel/swr"><button class="btn sm" data-act="gh-import" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Loading…" : "Import"}</button></div></label>
      <p class="small muted" style="margin-top:6px">Reads issues, pull requests, branches, the last 50 commits and up to 8 Markdown files (README, docs). Unauthenticated: 60 requests/hour.</p>
    </div>
    <div class="card">
      <div class="row between"><h3>Documents</h3><span class="tag">${s.docs.length} files</span></div>
      <div class="stack" style="margin-top:8px">${
        s.docs
          .map(
            (d, i) => `<div class="row between small"><span>${h(d.name)}</span><span class="row" style="gap:6px"><select data-act="doc-vis" data-i="${i}" aria-label="Who may see ${h(d.name)}" style="width:auto;padding:3px 6px"><option value="team" ${d.visibility === "team" ? "selected" : ""}>Whole team</option><option value="leads" ${d.visibility === "leads" ? "selected" : ""}>Leads only</option></select>${state.kind === "custom" || i >= 5 ? `<button class="btn sm ghost" data-act="rm-doc" data-i="${i}" aria-label="Remove ${h(d.name)}">✕</button>` : ""}</span></div>`
          )
          .join("") || `<p class="muted small">No documents yet.</p>`
      }</div>
    </div>
    <div class="card">
      <div class="row between"><h3>Chat</h3><span class="tag">${chats.reduce((n, c) => n + c.channels.length, 0)} channels</span></div>
      <div class="stack" style="margin-top:8px">${chats
        .flatMap((c) => c.channels)
        .map((ch) => {
          const priv = ch.is_private || ch.visibility === "private";
          return `<div class="row between small"><span>#${h(ch.name)} · ${ch.messages.length} msg</span>${priv ? `<span class="vis private">${s.includePrivate ? "private — hidden from all views" : "excluded (private)"}</span>` : `<span class="vis">${h(ch.visibility || "team")}</span>`}</div>`;
        })
        .join("") || `<p class="muted small">No chat export yet.</p>`}</div>
      ${D.excluded.length || s.includePrivate ? `<label class="check small" style="margin-top:10px"><input type="checkbox" data-act="toggle-private" ${s.includePrivate ? "checked" : ""}><span>Read private channels too. Their content stays hidden from every handover view.</span></label>` : ""}
    </div>
  </div>

  ${aiCard()}
  <div class="card section">
    <h3>Upload files</h3>
    <p class="small muted" style="margin-top:4px">Markdown or text docs (.md, .txt), chat exports (.json array of messages, Slack-style <span class="mono">{channels:[…]}</span>, WhatsApp .txt), or a GitHub-style <span class="mono">{issues, pulls}</span> JSON.</p>
    <div class="row" style="margin-top:10px">
      <input type="file" id="upload" multiple accept=".md,.markdown,.txt,.json" style="max-width:340px">
      <label class="field" style="flex-direction:row;align-items:center;gap:8px">Visible to <select id="upload-vis" style="width:auto"><option value="team">Whole team</option><option value="leads">Leads only</option></select></label>
      <button class="btn sm" data-act="upload">Add files</button>
    </div>
  </div>

  <div class="grid g2 section">
    <div class="card ${secrets.length ? "" : "flat"}">
      <h3>Removed on arrival</h3>
      <p class="small muted" style="margin-top:4px">Secrets are stripped before anything is stored or analysed. The original value is never kept.</p>
      <ul class="small" style="margin:10px 0 0;padding-left:18px">${secrets.map((f) => `<li><b>${h(f.name)}</b> removed from <button class="chip" data-act="ev" data-id="${h(f.evidenceId)}">${h(f.ref)}</button></li>`).join("") || "<li>No secrets found.</li>"}
      ${personal.length ? `<li>${personal.length} personal contact detail(s) masked (emails, phone numbers).</li>` : ""}</ul>
    </div>
    <div class="card flat">
      <h3>Ready to read</h3>
      <div class="grid g3" style="margin-top:10px">
        <div class="stat"><span class="v">${D.stats.bySource.github || 0}</span><span class="k">GitHub items</span></div>
        <div class="stat"><span class="v">${D.stats.bySource.docs || 0}</span><span class="k">document lines</span></div>
        <div class="stat"><span class="v">${D.stats.bySource.chat || 0}</span><span class="k">chat messages</span></div>
      </div>
      ${D.excluded.length ? `<p class="small muted" style="margin-top:10px">${D.excluded.map((x) => `#${h(x.channel)} (${x.messages} msg)`).join(", ")} not read: private.</p>` : ""}
    </div>
  </div>`;
}

function pageReconstruct() {
  if (!state.connected) return gate("connect", "Connect sources first.");
  const active = D.claims.filter((c) => c.status === "active");
  const by = (t) => active.filter((c) => c.type === t);
  const timeline = active.filter((c) => ["decision", "progress", "action"].includes(c.type) && c.date).sort((a, b) => a.date.localeCompare(b.date));
  const groups = [
    ["overview", "About the project"],
    ["decision", "Decisions"],
    ["owner", "Ownership"],
    ["dependency", "Dependencies and blockers"],
    ["risk", "Risks"],
    ["recurring", "Recurring problems"],
    ["question", "Open questions"],
    ["action", "Next actions"],
    ["contact", "Contacts"],
    ["budget", "Budget and money"],
    ["progress", "Progress and recent changes"],
    ["setup", "How to run it"],
    ["fact", "Key facts"],
  ];
  return `
  <div class="page-head"><div><p class="eyebrow">Step 2 of 5</p><h1 style="font-size:36px;margin-top:6px">What Baton reconstructed</h1>
  <p class="lede">${active.length} claims from ${D.stats.evidence} pieces of evidence, in ${D.ms} ms. Every claim below carries the exact source text it came from.</p></div>
  <div class="row"><a class="btn ghost" href="#/impact">Exit impact map · ${D.impact.score}/100</a><a class="btn amber" href="#/verify">Check the evidence →</a></div></div>
  <div class="card flat"><div class="grid g4">
    <div class="stat"><span class="v">${by("decision").length}</span><span class="k">decisions</span></div>
    <div class="stat"><span class="v">${by("owner").length}</span><span class="k">ownership facts</span></div>
    <div class="stat"><span class="v">${by("risk").length + by("dependency").length + by("recurring").length}</span><span class="k">risks, blockers, repeat problems</span></div>
    <div class="stat"><span class="v">${D.gaps.length}</span><span class="k">gaps for the leaver</span></div>
  </div></div>
  <div class="split section">
    <div class="stack">${groups
      .filter(([t]) => by(t).length)
      .map(([t, name]) => `<h2 style="margin-top:14px">${name} <span class="muted" style="font-size:16px">(${by(t).length})</span></h2>${by(t).sort((a, b) => b.risk - a.risk).map((c) => claimCard(c)).join("")}`)
      .join("")}</div>
    <aside class="card" style="position:sticky;top:76px">
      <h3>Timeline</h3>
      <p class="small muted" style="margin:4px 0 14px">Decisions, changes and actions in date order. Red = disputed.</p>
      <ol class="timeline">${timeline.map((c) => `<li class="${c.label === "Conflicting" ? "conf" : ""}"><div class="date">${prettyDate(c.date)}</div><div class="small">${h(c.type === "decision" ? `${topicName(c.topic)} → ${c.choice}` : claimText(c))}</div></li>`).join("")}
      <li class="conf"><div class="date">${prettyDate(state.project.exitDate)}</div><div class="small"><b>${h(state.project.leaver || "Leaver")}</b> leaves</div></li></ol>
    </aside>
  </div>`;
}

function pageVerify() {
  if (!state.connected) return gate("connect", "Connect sources first.");
  const active = D.claims.filter((c) => c.status === "active");
  const counts = Object.fromEntries(LABELS.map((l) => [l, active.filter((c) => c.label === l).length]));
  let list = active.filter((c) => (ui.label === "all" || c.label === ui.label) && (ui.type === "all" || c.type === ui.type));
  if (ui.q) list = list.filter((c) => (claimText(c) + " " + c.citations.map((x) => D.byId.get(x.evidenceId)?.ref).join(" ")).toLowerCase().includes(ui.q.toLowerCase()));
  const conflicts = D.conflicts;
  const st = D.stats;
  return `
  <div class="page-head"><div><p class="eyebrow">Step 3 of 5</p><h1 style="font-size:36px;margin-top:6px">The Claim Ledger</h1>
  <p class="lede">Each citation is checked: the quote must appear word-for-word in its source and mention what the claim is about. Labels are counted from the evidence.</p></div>
  <a class="btn amber" href="#/review?tab=gaps">Start the review →</a></div>
  <div class="grid g4">
    <div class="card flat stat"><span class="v">${st.citationsChecked}</span><span class="k">citations checked</span></div>
    <div class="card flat stat"><span class="v">${st.citationsChecked - st.citationsDropped}</span><span class="k">exact matches kept</span></div>
    <div class="card flat stat"><span class="v">${st.citationsDropped}</span><span class="k">dropped (failed check)</span></div>
    <div class="card flat stat"><span class="v" style="color:var(--red)">${conflicts.filter((c) => !c.resolved).length}</span><span class="k">open conflicts</span></div>
  </div>
  ${st.ai?.mode && st.ai.mode !== "off" ? `<div class="okbar" style="margin-top:12px;background:#efe9fb;color:#3b2a6b">✦ <b>AI added ${st.ai.accepted} claim(s)</b> that no rule recognised (from ${st.ai.considered} sentences the rules skipped) · ${st.ai.verified} confirmed by the second model · all labelled Inferred for review · <a href="#/ai">AI vs rules →</a></div>` : ""}
  ${
    conflicts.length
      ? `<section class="section"><h2>Conflicts, side by side</h2><div class="stack">${conflicts
          .map((conf) => {
            const cs = conf.claims.map((id) => D.claims.find((c) => c.id === id));
            const a = cs[0],
              rest = cs.slice(1);
            return `<div class="card flat"><div class="row between"><h3>${h(topicName(conf.topic))}</h3>${conf.resolved ? `<span class="badge b-resolved">Resolved: ${h(conf.resolved)} (gap interview)</span>` : `<span class="badge b-conflicting">Unresolved</span>`}</div>
            <div class="conflict" style="margin-top:10px">${claimCard(a)}<span class="vs">vs</span><div class="stack">${rest.map((c) => claimCard(c)).join("")}</div></div></div>`;
          })
          .join("")}</div></section>`
      : ""
  }
  ${spotCard()}
  <section class="section">
    <div class="row between"><h2>All claims</h2><input type="search" data-act="search" value="${h(ui.q)}" placeholder="Search claims or sources" style="max-width:280px" aria-label="Search claims"></div>
    <div class="filters" style="margin:12px 0">
      <button class="filter" data-act="flabel" data-v="all" aria-pressed="${ui.label === "all"}">All (${active.length})</button>
      ${LABELS.map((l) => `<button class="filter" data-act="flabel" data-v="${l}" aria-pressed="${ui.label === l}" title="${h(LABEL_HELP[l])}">${l} (${counts[l]})</button>`).join("")}
      <select data-act="ftype" style="width:auto" aria-label="Filter by type"><option value="all">All types</option>${Object.entries(TYPES)
        .map(([k, v]) => `<option value="${k}" ${ui.type === k ? "selected" : ""}>${v}</option>`)
        .join("")}</select>
    </div>
    <div class="legend" style="margin-bottom:12px">${LABELS.map((l) => `<span>${badge(l)} ${h(LABEL_HELP[l])}</span>`).join("")}</div>
    <div class="grid g2">${list.map((c) => claimCard(c)).join("") || `<p class="empty">No claims match.</p>`}</div>
  </section>`;
}

/** Human spot-check of citation support (Round 1 target: ≥ 95%). */
function spotCard() {
  state.spot ||= {};
  const acc = spotAccuracy(state.spot);
  const sample = sampleCitations(D.claims, state.spot, 5, state.spotSeed || 1);
  return `<section class="section"><div class="card">
    <div class="row between"><div><h3>Spot-check the citations</h3><p class="small muted" style="margin-top:4px">The exact-quote check proves a quote exists. Only a person can say whether it truly <i>supports</i> the claim. Check a random sample — Round 1 target: ≥ 95%.</p></div>
    <div class="stat" style="text-align:right"><span class="v" style="color:${acc.pct == null ? "#6b7280" : acc.pct >= 95 ? "#2F6690" : "#B23A0C"}">${acc.pct == null ? "—" : acc.pct + "%"}</span><span class="k">${acc.checked ? `${acc.yes} of ${acc.checked} checked support their claim` : "not measured yet"}</span></div></div>
    <div class="stack" style="margin-top:12px">${
      sample.length
        ? sample
            .map((u) => {
              const c = D.claims.find((x) => x.id === u.claimId);
              const e = D.byId.get(u.evidenceId);
              return `<div class="spot"><div class="small"><b>Claim:</b> ${h(claimText(c))}</div><blockquote class="small">“${h(u.quote)}” <span class="muted">— ${h(e?.ref || "")}</span></blockquote>
              <div class="row"><span class="small muted">Does the quote support the claim?</span><button class="btn sm ok" data-act="spot" data-v="yes" data-id="${h(u.key)}">Supports</button><button class="btn sm no" data-act="spot" data-v="no" data-id="${h(u.key)}">Doesn’t</button></div></div>`;
            })
            .join("")
        : `<p class="okbar">Every citation has been checked.</p>`
    }</div>
    ${acc.checked ? `<p class="small muted" style="margin-top:8px">Measured on ${acc.checked} citation(s). The result is saved with the next approved version. <button class="btn sm ghost" data-act="spot-reset">Reset</button></p>` : ""}
  </div></section>`;
}

function pageReview(params) {
  if (!state.connected) return gate("connect", "Connect sources first.");
  if (params.get("tab")) ui.tab = params.get("tab");
  const gaps = D.gaps;
  const answered = gaps.filter((g) => g.status !== "open").length;
  const active = D.claims.filter((c) => c.status === "active");
  const pending = active.filter((c) => !state.reviews[c.id]);
  const approved = active.filter((c) => state.reviews[c.id]?.status === "approved");
  const tabs = [
    ["gaps", `1 · Gap interview (${answered}/${gaps.length})`],
    ["claims", `2 · Approve claims (${approved.length}/${active.length})`],
    ["versions", `3 · Versions & audit (${state.versions.length})`],
  ];
  let body = "";
  if (ui.tab === "gaps") {
    body = `
    <div class="grid g2" style="margin-bottom:14px">
      <a class="readiness" href="#/impact" style="margin:0"><span class="rs-num">${D.impact.score}</span><span><b>Handover readiness</b><br><span class="small">Started at ${D.baseline}. Each answer raises it — see the impact map →</span></span></a>
      <div class="readiness" style="margin:0;border-left-color:${(state.interview?.activeMs || 0) <= 20 * 60000 ? "#2D6A4F" : "#B23A0C"}"><span class="rs-num" style="font-size:28px">${fmtDuration(state.interview?.activeMs || 0)}</span><span><b>Leaver effort</b><br><span class="small">${answered === gaps.length && gaps.length ? `Interview finished in ${fmtDuration(state.interview?.activeMs || 0)} — target ≤ 20 min ${(state.interview?.activeMs || 0) <= 20 * 60000 ? "met" : "missed"}.` : `Active time answering so far · target ≤ 20 min. Pauses over 5 min are capped.`}</span></span></div>
    </div>
    <div class="row between"><div style="flex:1;min-width:240px"><div class="progress" aria-label="Interview progress"><div style="width:${gaps.length ? (answered / gaps.length) * 100 : 0}%"></div></div>
      <p class="small muted" style="margin-top:6px">${answered} of ${gaps.length} handled · ranked by risk · skip anything you don’t know — it stays marked Missing.</p></div>
      <a class="btn ghost" href="#/review?tab=claims">Go to approval →</a></div>
    <div class="stack" style="margin-top:14px">${gaps.map(gapCard).join("") || `<p class="empty">No gaps — the evidence covers everything.</p>`}</div>`;
  } else if (ui.tab === "claims") {
    let list = active;
    if (ui.revFilter === "pending") list = pending;
    if (ui.revFilter === "approved") list = approved;
    if (ui.revFilter === "rejected") list = active.filter((c) => state.reviews[c.id]?.status === "rejected");
    const easy = pending.filter((c) => c.label === "Verified" || c.label === "Single-source");
    body = `
    <div class="card flat">
      <div class="row between">
        <div><h3>Approve a version for the successor</h3><p class="small muted" style="margin-top:4px">${approved.length} approved · ${pending.length} pending · pending and rejected claims are left out of the handover.</p></div>
        <div class="row"><label class="field" style="flex-direction:row;align-items:center;gap:6px">Reviewer <input data-act="reviewer" value="${h(state.reviewer)}" style="width:160px"></label>
        <button class="btn amber" data-act="publish" ${approved.length ? "" : "disabled"}>Approve version ${state.versions.length + 1} →</button></div>
      </div>
    </div>
    <div class="filters" style="margin:14px 0">
      ${["pending", "approved", "rejected", "all"].map((f) => `<button class="filter" data-act="revfilter" data-v="${f}" aria-pressed="${ui.revFilter === f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}
      <span style="flex:1"></span>
      <button class="btn sm ghost" data-act="bulk-approve" ${easy.length ? "" : "disabled"} title="Approve every pending Verified and Single-source claim">Approve all ${easy.length} Verified + Single-source</button>
    </div>
    <p class="small muted" style="margin-bottom:10px">Conflicting, Inferred and Missing claims need a decision one by one. Approving them shares them <b>with their label</b>, so the successor still sees the uncertainty.</p>
    <div class="grid g2">${list.sort((a, b) => b.risk - a.risk).map((c) => claimCard(c, { review: true })).join("") || `<p class="empty">Nothing here.</p>`}</div>`;
  } else {
    body = `<div class="grid g2">
      <div class="card flat"><h3>Approved versions</h3>${
        state.versions.length
          ? `<table class="ledger" style="margin-top:8px"><tr><th>Version</th><th>Approved by</th><th>When</th><th>Claims</th></tr>${state.versions
              .slice()
              .reverse()
              .map((v) => `<tr><td>v${v.n}</td><td>${h(v.by)}</td><td>${h(new Date(v.at).toLocaleString())}</td><td>${v.approved}</td></tr>`)
              .join("")}</table>`
          : `<p class="muted small" style="margin-top:8px">No version approved yet.</p>`
      }
      <h3 style="margin-top:18px">Receipts</h3>${state.acks.length ? `<ul class="small">${state.acks.map((a) => `<li>${h(a.name)} (${h(ROLES[a.role]?.name)}) acknowledged v${a.version} — ${h(new Date(a.at).toLocaleString())}</li>`).join("")}</ul>` : `<p class="muted small">No receipts yet.</p>`}</div>
      <div class="card flat"><h3>Audit log</h3><ol class="small" style="margin-top:8px;padding-left:18px;max-height:480px;overflow:auto">${state.audit
        .slice()
        .reverse()
        .map((a) => `<li><span class="mono muted">${h(new Date(a.at).toLocaleString())}</span> · <b>${h(a.who)}</b> ${h(a.action)}${a.detail ? ` — ${h(a.detail)}` : ""}</li>`)
        .join("")}</ol></div></div>`;
  }
  return `
  <div class="page-head"><div><p class="eyebrow">Step 4 of 5</p><h1 style="font-size:36px;margin-top:6px">Review</h1>
  <p class="lede">First the person leaving fills the gaps. Then a reviewer approves, edits or rejects each claim and signs off a version.</p></div>
  ${state.versions.length ? `<a class="btn amber" href="#/handover">Open the handover →</a>` : ""}</div>
  <div class="tabs" role="tablist">${tabs.map(([id, name]) => `<button class="tab" role="tab" aria-selected="${ui.tab === id}" data-act="tab" data-v="${id}">${name}</button>`).join("")}</div>
  ${body}`;
}

function gapCard(g) {
  const a = state.answers[g.id];
  const people = peopleOptions();
  const head = `<div class="row between"><div class="row"><span class="tag ${g.risk >= 3 ? "risk-3" : ""}">${riskName(g.risk)} risk · ${h(g.title)}</span></div>${g.status === "answered" ? `<span class="badge b-resolved">Answered</span>` : g.status === "skipped" ? `<span class="badge b-missing">Skipped — stays Missing</span>` : ""}</div>
    <p style="font-size:16px">${h(g.prompt)}</p>
    <div class="cites">${g.claimIds
      .map((id) => D.claims.find((c) => c.id === id))
      .filter(Boolean)
      .map(chips)
      .join("")}</div>`;
  if (g.status !== "open") {
    return `<div class="gap ${g.status}">${head}${a && !a.skipped ? `<div class="extra small" style="background:#eef6f1;border-radius:8px;padding:8px 10px"><b>Your answer:</b> ${h(a.choice ? a.choice + ". " : "")}${h(a.owner ? "Owner: " + a.owner + ". " : "")}${h(a.text || "")}</div>` : ""}<div><button class="btn sm ghost" data-act="unanswer" data-gap="${h(g.id)}">Change answer</button></div></div>`;
  }
  let input = "";
  if (g.type === "conflict") {
    input = `<div class="opts" role="radiogroup" aria-label="Which is current">${g.options.map((o, i) => `<label><input type="radio" name="ch-${h(g.id)}" value="${h(o)}" ${i === g.options.length - 1 ? "" : ""}><span>${h(o)}</span></label>`).join("")}</div>
      <textarea data-f="text" placeholder="Optional: why, or since when"></textarea>`;
  } else if (g.type === "owner" || g.type === "handoff") {
    input = `<div class="grid g2"><label class="field">New owner<input data-f="owner" list="gap-people" placeholder="Name"></label><label class="field">Status or note<input data-f="text" placeholder="${g.type === "handoff" ? "e.g. half done, tests missing" : "Optional"}"></label></div><datalist id="gap-people">${people.map((p) => `<option value="${h(p)}">`).join("")}</datalist>`;
  } else {
    input = `<textarea data-f="text" placeholder="${g.type === "recurring" ? "Cause and permanent fix, if known" : "Your answer"}"></textarea>`;
  }
  return `<div class="gap" data-gapform="${h(g.id)}">${head}${input}
    <div class="row"><button class="btn sm ok" data-act="answer" data-gap="${h(g.id)}">Save answer</button><button class="btn sm ghost" data-act="skip" data-gap="${h(g.id)}">I don’t know — skip</button>
    <label class="small muted row" style="gap:6px">Answer visible to <select data-f="visibility" style="width:auto;padding:3px 6px"><option value="team">Whole team</option><option value="leads">Leads only</option></select></label></div></div>`;
}

/** The handover currently on screen: local project or shared link. */
function currentHandover() {
  if (viewing && VD) return { ho: buildHandover({ role: VD.role, claims: VD.claims, evidence: VD.evidence, reviews: VD.reviews, project: VD.project }), reviews: VD.reviews, evidence: VD.evidence, v: VD.version, project: VD.project };
  const v = latestVersion();
  return { ho: buildHandover({ role: ui.role, claims: D.claims, evidence: D.evidence, reviews: v.reviews, project: state.project }), reviews: v.reviews, evidence: D.evidence, v, project: state.project };
}

function latestVersion() {
  return state.versions[state.versions.length - 1];
}

function handoverDoc(ho, reviews, project, v) {
  const S = ho.sections;
  const cite = (c) => `<span class="cites" style="display:inline-flex">${chips(c)}</span>`;
  const li = (c) => `<li style="margin-bottom:10px">${badge(c.label)} ${h(reviews[c.id]?.text || c.text)}${c.answer ? ` <i>— Answer: ${h(c.answer)}</i>` : ""}${c.fix ? ` <i>— Fix: ${h(c.fix)}</i>` : ""}<div style="margin-top:4px">${cite(c)}</div></li>`;
  return `<article class="doc">
      <p class="eyebrow">Handover · ${h(ho.roleName)} view · v${v.n}</p>
      <h1 style="font-size:34px;margin-top:8px">${h(project.name)}</h1>
      <p class="muted" style="margin-top:6px">${h(project.leaver)} leaves on ${prettyDate(project.exitDate)}. ${h(ROLES[ho.role].blurb)}</p>
      <div class="legend" style="margin-top:12px">${LABELS.map((l) => `<span>${badge(l)}</span>`).join("")}</div>
      ${S.about.length ? `<h2>About the project</h2><ul style="padding-left:18px">${S.about.map(li).join("")}</ul>` : ""}
      <h2>Where things stand</h2>
      <table class="state-table">${S.state.map((s) => `<tr><td>${h(s.topic)}</td><td>${s.uncertain && /unresolved/.test(s.value) ? `<span class="fail">${h(s.value)}</span>` : `<b>${h(s.value)}</b> ${s.uncertain ? badge(s.label) : badge("Verified")}`}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">No approved decisions.</td></tr>`}</table>
      <h2>First 72 hours</h2>
      <ol class="plan">${S.plan.map((p) => `<li><span class="day">${p.day}</span><div><div>${h(p.text)}</div><div class="small muted">${h(p.why)} · <a href="#c-${h(p.claimId)}" data-act="jump" data-id="${h(p.claimId)}">evidence</a></div></div></li>`).join("") || `<li><span></span><span></span><span class="muted">No actions.</span></li>`}</ol>
      <h2>Open questions and conflicts</h2><ul style="padding-left:18px">${S.open.map(li).join("") || `<li class="muted">None.</li>`}</ul>
      <h2>Risks, blockers and repeat problems</h2><ul style="padding-left:18px">${S.risks.map(li).join("") || `<li class="muted">None.</li>`}</ul>
      <h2>Who owns what, and who to ask</h2><ul style="padding-left:18px">${S.people.map(li).join("") || `<li class="muted">None.</li>`}</ul>
      ${S.setup.length ? `<h2>How to run it</h2><ul style="padding-left:18px">${S.setup.map(li).join("")}</ul>` : ""}
      ${S.facts.length ? `<details><summary><h2 style="display:inline">Key facts (${S.facts.length})</h2></summary><ul style="padding-left:18px;margin-top:10px">${S.facts.map(li).join("")}</ul></details>` : ""}
      ${S.money.length ? `<h2>Budget and money</h2><ul style="padding-left:18px">${S.money.map(li).join("")}</ul>` : ""}
      <h2>Decision timeline</h2>
      ${S.rejected.length ? `<p class="small muted" style="margin-bottom:10px">Struck-through entries are rejected options: what was once decided or claimed, kept so you know what <i>not</i> to rebuild.</p>` : ""}
      <ol class="timeline">${S.timeline
        .map((c) =>
          c.rejected
            ? `<li class="rej" id="c-${h(c.id)}"><div class="date">${prettyDate(c.date)}</div><div><span class="badge b-superseded">Rejected option</span> <s>${h(c.text)}</s> <span class="small muted">— superseded by <b>${h(c.supersededBy)}</b> in the gap interview</span></div><div style="margin-top:4px">${cite(c)}</div></li>`
            : `<li class="${c.label === "Conflicting" ? "conf" : ""}" id="c-${h(c.id)}"><div class="date">${prettyDate(c.date)}</div><div>${badge(c.label)} ${h(reviews[c.id]?.text || c.text)}</div><div style="margin-top:4px">${cite(c)}</div></li>`
        )
        .join("")}</ol>
    </article>`;
}

function askCard(by) {
  return `<div class="card">
        <h3>Ask the handover</h3>
        <p class="small muted" style="margin-top:4px">Answers come only from approved claims you’re allowed to see.</p>
        <div class="row" style="margin-top:10px;flex-wrap:nowrap"><input id="ask-q" value="${h(ui.askQ)}" placeholder="e.g. Who owns the venue booking?"><button class="btn sm" data-act="ask">Ask</button></div>
        ${
          ui.askRes
            ? ui.askRes.matches.length
              ? `<div class="stack" style="margin-top:12px">${ui.askRes.matches.map((c) => claimCard(c)).join("")}</div>`
              : `<p class="warnbar" style="margin-top:12px">The approved handover doesn’t answer this. Ask ${h(by)} — don’t guess.</p>`
            : `<p class="small muted" style="margin-top:10px">Try: “What is the launch date?”, “Who owns the QR scanner?”, “What’s the budget?” (as a developer).</p>`
        }
      </div>`;
}

/** Successor readiness check: questions generated from this role's approved handover. */
function quizCard(ho, reviews, history) {
  const qs = buildQuiz(ho, reviews);
  const q = ui.quiz;
  if (!qs.length) return "";
  if (!q || q.role !== ho.role || q.key !== ho.list.length) {
    const last = history[history.length - 1];
    return `<div class="card"><h3>Readiness check</h3>
      <p class="small muted" style="margin-top:4px">${qs.length} questions generated from this handover. It measures whether the successor can actually continue the work — Round 1 promised this test.</p>
      ${last ? `<p class="okbar" style="margin-top:10px">Last result: <b>${last.right}/${last.total}</b> in ${fmtDuration(last.ms)}${last.name ? ` by ${h(last.name)}` : ""}</p>` : ""}
      <p style="margin-top:10px"><button class="btn sm amber" data-act="quiz-start">Take the check (${qs.length} questions)</button></p></div>`;
  }
  if (q.result) {
    return `<div class="card"><h3>Readiness check — ${q.result.right}/${q.result.total}</h3>
      <p class="small muted" style="margin-top:4px">${fmtDuration(q.result.ms)} · ${q.result.pct}% correct.</p>
      <ol class="small" style="padding-left:18px;margin-top:10px">${qs
        .map((x) => {
          const ok = q.answers[x.id] === x.answer;
          const c = cx().claims.find((cl) => cl.id === x.claimId) || ho.list.find((cl) => cl.id === x.claimId);
          return `<li style="margin-bottom:10px"><b>${h(x.prompt)}</b><br><span class="${ok ? "pass" : "fail"}">${ok ? "Correct" : `Your answer: ${h(q.answers[x.id] || "—")}`}</span>${ok ? "" : ` · Right answer: <b>${h(x.answer)}</b>`}${c ? `<div style="margin-top:4px">${chips(c)}</div>` : ""}</li>`;
        })
        .join("")}</ol>
      <button class="btn sm ghost" data-act="quiz-close">Done</button></div>`;
  }
  return `<div class="card" id="quiz"><h3>Readiness check</h3><p class="small muted" style="margin-top:4px">Answer from what you just read. Timed from now.</p>
    <div class="stack" style="margin-top:12px">${qs
      .map((x, i) => `<fieldset class="quizq"><legend><b>${i + 1}.</b> ${h(x.prompt)}</legend>${x.options.map((o) => `<label class="check small"><input type="radio" name="q-${h(x.id)}" value="${h(o)}"><span>${h(o)}</span></label>`).join("")}</fieldset>`)
      .join("")}</div>
    <div class="row" style="margin-top:12px"><input id="quiz-name" placeholder="Your name (optional)" style="max-width:200px"><button class="btn sm amber" data-act="quiz-submit">Submit answers</button><button class="btn sm ghost" data-act="quiz-close">Cancel</button></div></div>`;
}

function shareCard(ho) {
  return `<div class="card"><h3>Share with the successor</h3>
    <p class="small muted" style="margin-top:4px">Creates a read-only link to this <b>${h(ho.roleName)}</b> view. Only what this role may see goes into the link — the data travels inside the link itself, after the #, and is never uploaded anywhere.</p>
    ${ui.shareUrl && ui.shareRole === ho.role ? `<input id="share-url" readonly value="${h(ui.shareUrl)}" style="margin-top:10px;font-size:12px" aria-label="Share link"><div class="row" style="margin-top:8px"><button class="btn sm" data-act="share-copy">Copy link</button><a class="btn sm ghost" href="${h(ui.shareUrl)}" target="_blank" rel="noopener">Open ↗</a><span class="small muted">${Math.round(ui.shareUrl.length / 1024)} KB</span></div>` : `<p style="margin-top:10px"><button class="btn sm" data-act="share">Create share link</button></p>`}</div>`;
}

function pageHandover() {
  if (!state.connected) return gate("connect", "Connect sources first.");
  const v = latestVersion();
  if (!v) return gate("review?tab=claims", "No version has been approved yet. A reviewer must approve one in Step 4 before anything is shared.", "Go to approval");
  const reviews = v.reviews;
  const ho = buildHandover({ role: ui.role, claims: D.claims, evidence: D.evidence, reviews, project: state.project });
  const lc = leakCheck(ho, D.evidence);
  const changed = JSON.stringify(reviews) !== JSON.stringify(state.reviews);
  const myAck = state.acks.find((a) => a.role === ui.role && a.version === v.n);
  const metrics = [
    v.readiness != null ? `Handover readiness <b>${v.readiness}/100</b>` : null,
    v.leaverMs != null ? `leaver effort <b>${fmtDuration(v.leaverMs)}</b> (target ≤ 20 min)` : null,
    v.spot?.checked ? `citation accuracy <b>${v.spot.pct}%</b> on ${v.spot.checked} hand-checked` : null,
  ].filter(Boolean);
  return `
  <div class="page-head no-print"><div><p class="eyebrow">Step 5 of 5</p><h1 style="font-size:36px;margin-top:6px">The handover</h1>
  <p class="lede">Built only from version ${v.n}, approved by ${h(v.by)}. Switch role to see how permissions change what is shown.</p></div>
  <div class="row"><button class="btn ghost" data-act="export">Download Markdown</button><button class="btn ghost" data-act="print">Print / save PDF</button></div></div>
  <div class="tabs no-print" role="tablist">${Object.entries(ROLES)
    .map(([id, r]) => `<button class="tab" role="tab" aria-selected="${ui.role === id}" data-act="role" data-v="${id}">${r.name} view</button>`)
    .join("")}</div>
  <div class="stack no-print" style="margin-bottom:16px">
    ${metrics.length ? `<div class="okbar" style="background:#e8eef6;color:#1d4a6c">At approval: ${metrics.join(" · ")} · <a href="#/impact">impact map</a></div>` : ""}
    <div class="${lc.ok ? "okbar" : "badbar"}"><b>${lc.ok ? "Leak check passed" : "Leak check FAILED"}</b> · ${ho.list.length} claims shown · ${ho.hiddenForPermissions} approved claim(s) withheld because they cite sources the ${h(ho.roleName)} role can’t see · private channels never shown</div>
    ${changed ? `<div class="warnbar">The reviewer has changes that are not in an approved version yet. The successor still sees version ${v.n}.</div>` : ""}
  </div>
  <div class="split">
    ${handoverDoc(ho, reviews, state.project, v)}
    <aside class="stack no-print" style="position:sticky;top:76px">
      ${quizCard(ho, reviews, (state.quizzes || []).filter((x) => x.role === ui.role && x.version === v.n))}
      ${askCard(v.by)}
      ${shareCard(ho)}
      <div class="card">
        <h3>Acknowledge receipt</h3>
        ${
          myAck
            ? `<p class="okbar" style="margin-top:8px">Received by ${h(myAck.name)} on ${h(new Date(myAck.at).toLocaleString())}.</p>`
            : `<p class="small muted" style="margin-top:4px">Confirms you have read version ${v.n}. Logged in the audit trail.</p>
          <div class="row" style="margin-top:10px;flex-wrap:nowrap"><input id="ack-name" placeholder="Your name"><button class="btn sm amber" data-act="ack">I’ve read it</button></div>`
        }
      </div>
    </aside>
  </div>`;
}

/** The read-only page a successor opens from a share link. */
function pageView() {
  const d = VD;
  const ho = buildHandover({ role: d.role, claims: d.claims, evidence: d.evidence, reviews: d.reviews, project: d.project });
  const lc = leakCheck(ho, d.evidence);
  const local = (() => {
    try {
      return JSON.parse(localStorage.getItem("baton:quiz:view") || "[]");
    } catch {
      return [];
    }
  })().filter((x) => x.key === d.key);
  return `
  <div class="page-head no-print"><div><p class="eyebrow">Shared handover · read-only</p><h1 style="font-size:36px;margin-top:6px">${h(d.project.name)}</h1>
  <p class="lede">${h(ROLES[d.role].name)} view, version ${d.version.n}, approved by ${h(d.version.by)} on ${prettyDate((d.version.at || "").slice(0, 10))}. Everything below came inside this link; nothing was loaded from a server.</p></div>
  <div class="row"><button class="btn ghost" data-act="export">Download Markdown</button><button class="btn ghost" data-act="print">Print / save PDF</button></div></div>
  <div class="stack no-print" style="margin-bottom:16px">
    <div class="${lc.ok ? "okbar" : "badbar"}"><b>${lc.ok ? "Leak check passed" : "Leak check FAILED"}</b> · ${ho.list.length} approved claims · only sources the ${h(ho.roleName)} role may see were put in this link${d.version.readiness != null ? ` · readiness at approval ${d.version.readiness}/100` : ""}</div>
  </div>
  <div class="split">
    ${handoverDoc(ho, d.reviews, d.project, d.version)}
    <aside class="stack no-print" style="position:sticky;top:76px">
      ${quizCard(ho, d.reviews, local)}
      ${askCard(d.version.by)}
      <div class="card"><h3>About this link</h3><p class="small muted" style="margin-top:4px">Anyone with this link can read this view. To get a newer version, ask ${h(d.version.by)} for a new link.</p><p style="margin-top:10px"><a class="btn sm ghost" href="#/">What is Baton?</a></p></div>
    </aside>
  </div>`;
}

const STATUS_COLOR = { secured: "#2F6690", partial: "#D08A16", "at-risk": "#B23A0C" };
const STATUS_NAME = { secured: "Secured", partial: "Partly secured", "at-risk": "At risk" };

function gauge(score, from) {
  const R = 84, C = 2 * Math.PI * R;
  const off = (v) => C * (1 - v / 100);
  const col = score >= 75 ? "#2F6690" : score >= 45 ? "#D08A16" : "#B23A0C";
  return `<svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Handover readiness ${score} out of 100">
    <circle cx="100" cy="100" r="${R}" fill="none" stroke="#E7E1D3" stroke-width="18"/>
    <circle id="gauge-arc" cx="100" cy="100" r="${R}" fill="none" stroke="${col}" stroke-width="18" stroke-linecap="round" transform="rotate(-90 100 100)" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off(from).toFixed(1)}" data-to="${off(score).toFixed(1)}" style="transition:stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)"/>
    <text x="100" y="104" text-anchor="middle" font-family="Space Grotesk, Arial, sans-serif" font-size="56" font-weight="700" fill="#161B24">${score}</text>
    <text x="100" y="134" text-anchor="middle" font-family="IBM Plex Sans, Arial, sans-serif" font-size="14" fill="#4E5663">out of 100</text></svg>`;
}

function pageImpact() {
  if (!state.connected) return gate("connect", "Connect sources first.");
  const im = D.impact;
  const L = layoutImpact(im);
  const pos = new Map(L.nodes.map((n) => [n.id, n]));
  const sel = im.units.find((u) => u.id === ui.impactSel);
  const from = ui.lastScore ?? D.baseline;
  ui.lastScore = im.score;
  const edges = L.edges
    .map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      const handoff = e.status === "handoff";
      const mx = (a.x + b.x) / 2;
      return `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} C${mx.toFixed(1)} ${a.y.toFixed(1)} ${mx.toFixed(1)} ${b.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" fill="none" stroke="${handoff ? "#2D6A4F" : STATUS_COLOR[e.status]}" stroke-width="${handoff ? 2.5 : 1.6}" stroke-opacity="${handoff ? 0.9 : 0.4}" ${handoff ? 'stroke-dasharray="6 5"' : ""}/>`;
    })
    .join("");
  const nodes = L.nodes
    .map((n) => {
      if (n.kind === "leaver")
        return `<g><circle cx="${n.x}" cy="${n.y}" r="56" fill="#161B24"/><circle cx="${n.x}" cy="${n.y}" r="64" fill="none" stroke="#E8A93E" stroke-width="3" stroke-dasharray="4 6"/><text x="${n.x}" y="${n.y - 4}" text-anchor="middle" fill="#F5F2EA" font-family="Space Grotesk, Arial, sans-serif" font-size="17" font-weight="700">${h(n.label.split(" ")[0])}</text><text x="${n.x}" y="${n.y + 16}" text-anchor="middle" fill="#E8A93E" font-family="IBM Plex Mono, monospace" font-size="11">LEAVING ${h(prettyDate(state.project.exitDate).replace(/ \d{4}$/, "").toUpperCase())}</text></g>`;
      if (n.kind === "person")
        return `<g><rect x="${n.x - 62}" y="${n.y - 17}" width="124" height="34" rx="17" fill="#DCEFE4" stroke="#2D6A4F"/><text x="${n.x}" y="${n.y + 5}" text-anchor="middle" fill="#1F4D39" font-family="IBM Plex Sans, Arial, sans-serif" font-size="13" font-weight="600">→ ${h(n.label)}</text></g>`;
      const u = n.unit;
      const r = 7 + u.weight * 3;
      const right = n.right;
      const lx = n.x + (right ? r + 6 : -r - 6);
      const label = u.label.length > 34 ? u.label.slice(0, 33) + "…" : u.label;
      const on = ui.impactSel === u.id;
      return `<g class="inode" data-act="impact-node" data-id="${h(u.id)}" tabindex="0" role="button" aria-label="${h(`${CATEGORY[u.category]}: ${u.label}. ${STATUS_NAME[u.status]}. ${u.why}`)}"><title>${h(`${CATEGORY[u.category]} · ${STATUS_NAME[u.status]} — ${u.why}`)}</title>
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r + (on ? 5 : 0)}" fill="${STATUS_COLOR[u.status]}" stroke="${on ? "#161B24" : "#FFFDF8"}" stroke-width="${on ? 3 : 2}"/>
        ${u.status === "secured" ? `<path d="M${(n.x - 5).toFixed(1)} ${n.y.toFixed(1)} l4 4 l7 -8" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>` : u.status === "at-risk" ? `<text x="${n.x.toFixed(1)}" y="${(n.y + 5).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="15" font-weight="700" font-family="Arial">!</text>` : ""}
        <text x="${lx.toFixed(1)}" y="${(n.y + 4).toFixed(1)}" text-anchor="${right ? "start" : "end"}" fill="#161B24" font-family="IBM Plex Sans, Arial, sans-serif" font-size="13">${h(label)}</text></g>`;
    })
    .join("");
  const bars = im.breakdown
    .map((b) => `<div class="stack" style="gap:4px"><div class="row between small"><span>${h(b.name)}</span><span class="mono">${b.secured}/${b.total}</span></div><div class="progress" style="height:7px"><div style="width:${(b.secured / b.total) * 100}%;background:${b.secured === b.total ? "#2F6690" : "#D08A16"}"></div></div></div>`)
    .join("");
  const top = im.units.filter((u) => u.status === "at-risk").sort((a, b) => b.weight - a.weight).slice(0, 4);
  return `
  <div class="page-head"><div><p class="eyebrow">Exit impact map</p><h1 style="font-size:36px;margin-top:6px">What leaves with ${h(state.project.leaver || "the leaver")}</h1>
  <p class="lede">${im.units.length} pieces of knowledge are tied to this exit. Red will be lost unless someone acts, amber is only partly covered, blue is secured with evidence or testimony. Click any dot to see why.</p></div>
  <a class="btn amber" href="#/review?tab=gaps">Close the gaps →</a></div>
  <div class="impact-grid">
    <aside class="stack">
      <div class="card" style="text-align:center">
        <p class="eyebrow">Handover readiness</p>
        <div style="display:flex;justify-content:center;margin-top:8px">${gauge(im.score, from)}</div>
        <p class="small muted">${im.score === D.baseline ? `Today, a successor would inherit ${im.score}% of this knowledge safely.` : `Up from <b>${D.baseline}</b> before the gap interview.`}</p>
        <div class="row" style="justify-content:center;margin-top:10px;gap:6px">
          <span class="badge" style="background:#dbe8f2;color:#1d4a6c">${im.counts.secured} secured</span>
          <span class="badge" style="background:#fdf0d6;color:#8a5300">${im.counts.partial} partial</span>
          <span class="badge" style="background:#f8e1d8;color:#8f2e08">${im.counts.atRisk} at risk</span>
        </div>
      </div>
      <div class="card flat stack">${bars}</div>
      <p class="small muted">Score = weighted share of knowledge units that are secured (1) or partly secured (½), weighted by risk 1–3. Computed from the ledger, not estimated.</p>
    </aside>
    <div class="stack">
      <div class="card" style="padding:8px">
        <svg viewBox="0 0 ${L.W} ${L.H}" width="100%" role="group" aria-label="Exit impact map" style="display:block">${edges}${nodes}</svg>
        <div class="legend" style="padding:6px 12px 10px"><span><i class="dot" style="background:#B23A0C"></i>At risk</span><span><i class="dot" style="background:#D08A16"></i>Partly secured</span><span><i class="dot" style="background:#2F6690"></i>Secured</span><span><i class="dot" style="background:#2D6A4F"></i>Handed to a new owner</span><span>Bigger dot = higher risk</span></div>
      </div>
      ${
        sel
          ? `<div class="card"><div class="row between"><div><p class="eyebrow">${h(CATEGORY[sel.category])}</p><h3 style="margin-top:4px">${h(sel.label)}</h3></div><span class="badge" style="background:${STATUS_COLOR[sel.status]};color:#fff">${STATUS_NAME[sel.status]}</span></div>
            <p class="muted" style="margin:6px 0 12px">${h(sel.why)}</p>
            <div class="stack">${sel.claimIds.map((id) => D.claims.find((c) => c.id === id)).filter(Boolean).map((c) => claimCard(c)).join("")}</div>
            ${sel.status !== "secured" ? `<p style="margin-top:12px"><a class="btn sm amber" href="#/review?tab=gaps">Fix this in the gap interview →</a></p>` : ""}</div>`
          : `<div class="card flat"><h3>Biggest risks right now</h3>${top.length ? `<ol class="small" style="margin:8px 0 0;padding-left:18px">${top.map((u) => `<li style="margin-bottom:6px"><a href="#/impact" data-act="impact-node" data-id="${h(u.id)}">${h(u.label)}</a> — ${h(u.why)}</li>`).join("")}</ol>` : `<p class="okbar" style="margin-top:8px">Nothing is at risk. Every piece of knowledge tied to this exit is secured or partly covered.</p>`}</div>`
      }
    </div>
  </div>
  <details class="card flat section"><summary><b>All ${im.units.length} knowledge units (table view)</b></summary>
    <table class="ledger" style="margin-top:10px"><tr><th>Status</th><th>Area</th><th>Knowledge</th><th>Why</th><th>Risk</th></tr>
    ${im.units.map((u) => `<tr><td style="color:${STATUS_COLOR[u.status]};font-weight:600">${STATUS_NAME[u.status]}</td><td>${h(CATEGORY[u.category])}</td><td>${h(u.label)}</td><td>${h(u.why)}</td><td>${u.weight}</td></tr>`).join("")}</table></details>`;
}

function aiCard() {
  const mode = state.aiMode ?? "local";
  const opt = (v, t, d) => `<label class="aiopt ${mode === v ? "on" : ""}"><input type="radio" name="ai-mode" value="${v}" data-act="ai-mode" ${mode === v ? "checked" : ""}><span><b>${t}</b><br><span class="small muted">${d}</span></span></label>`;
  return `<div class="card section">
    <div class="row between"><h3>✦ AI extraction</h3><a class="small" href="#/ai">How well does it work? →</a></div>
    <p class="small muted" style="margin-top:4px">Rules only find phrasing they were written for. AI reads the sentences the rules skip and finds decisions, risks, blockers, questions and tasks however they are worded. Every AI finding keeps its exact quote, is checked by a second model, and is labelled Inferred until a person approves it.</p>
    <div class="grid g3" style="margin-top:12px">
      ${opt("local", "Built-in model (default)", `Runs offline in this browser. Trained on ${MODEL.trainedOn} sentences; nothing is sent anywhere.`)}
      ${opt("claude", "Claude (your API key)", "Sends sentences to Anthropic for labelling; Baton’s own model still checks each one.")}
      ${opt("off", "Off — rules only", "Exactly what the rules find, nothing more.")}
    </div>
    ${
      mode === "claude"
        ? `<div class="stack" style="margin-top:12px">
        <div class="grid g2"><label class="field">Anthropic API key (kept only in this tab, never saved)<input type="password" id="claude-key" value="${h(ui.claudeKey || "")}" placeholder="sk-ant-…" autocomplete="off"></label>
        <label class="field">Model<input id="claude-model" value="${h(ui.claudeModel || "claude-haiku-5-5")}"></label></div>
        <div class="row"><button class="btn sm" data-act="claude-run" ${ui.busy ? "disabled" : ""}>${ui.busy ? h(ui.busyText || "Working…") : state.llm ? "Re-run Claude on this project" : "Run Claude on this project"}</button>
        ${state.llm ? `<span class="small muted">Labelled ${state.llm.count} sentences with ${h(state.llm.model)} on ${h(new Date(state.llm.at).toLocaleString())}.</span>` : `<span class="small muted">Until you run it, the built-in model is used.</span>`}</div>
        <p class="small muted">Your sentences are sent to Anthropic’s API. Secrets and contact details were already removed on arrival. Don’t use this on data you’re not allowed to share.</p></div>`
        : ""
    }
  </div>`;
}

const pct = (x) => `${Math.round(x * 100)}%`;
function metricRow(name, m, note = "") {
  return `<tr><td><b>${name}</b>${note ? `<br><span class="small muted">${note}</span>` : ""}</td><td>${pct(m.micro.precision)}</td><td>${pct(m.micro.recall)}</td><td><b>${pct(m.micro.f1)}</b></td>${["decision", "risk", "dependency", "question", "action"].map((l) => `<td>${pct(m.per[l].f1)}</td>`).join("")}</tr>`;
}

function pageAI() {
  const r = (ui.evalLocal ||= evaluate(TEST));
  const c = ui.claudeEval;
  const tryRes = ui.tryText ? { rule: ruleTypeOf(ui.tryText), ai: classify(ui.tryText) } : null;
  const miss = r.rows.filter((x) => x.rule === "none" && x.gold !== "none" && x.ai === x.gold).slice(0, 6);
  return `
  <div class="page-head"><div><p class="eyebrow">AI vs rules</p><h1 style="font-size:36px;margin-top:6px">Rules + AI find ${pct(r.combined.micro.recall)} of the test items; rules alone find ${pct(r.rules.micro.recall)}</h1>
  <p class="lede">Measured on a held-out set of ${r.n} labelled sentences written in the style of chats, notes, commits and READMEs. None of them were used to train the model.</p></div>
  <a class="btn ghost" href="#/connect">AI settings</a></div>
  <div class="grid g4">
    <div class="card flat stat"><span class="v">${pct(r.rules.micro.f1)}</span><span class="k">rules only (F1)</span></div>
    <div class="card flat stat"><span class="v" style="color:#5b3fb0">${pct(r.combined.micro.f1)}</span><span class="k">rules + AI (F1)</span></div>
    <div class="card flat stat"><span class="v">${pct(r.combined.micro.precision)}</span><span class="k">precision kept (rules + AI)</span></div>
    <div class="card flat stat"><span class="v">${pct(r.aiVerified.micro.precision)}</span><span class="k">precision when both AI models agree</span></div>
  </div>
  <div class="card section"><h3>Results on the held-out test set</h3>
    <div style="overflow-x:auto"><table class="ledger" style="margin-top:8px;min-width:760px"><tr><th>Method</th><th>Precision</th><th>Recall</th><th>F1</th><th>Decision</th><th>Risk</th><th>Blocker</th><th>Question</th><th>Action</th></tr>
    ${metricRow("Rules only", r.rules, "Today’s pattern rules")}
    ${metricRow("Built-in AI", r.ai, "Main model ≥ 60% sure")}
    ${metricRow("AI, both models agree", r.aiVerified, "Main model + independent second model")}
    ${metricRow("AI, second model disagrees", r.aiUnverified, "Flagged “check carefully” in the app")}
    ${metricRow("Rules + AI (what Baton uses)", r.combined, "Rules first, AI for what they skip")}
    ${c ? metricRow(`Claude (${h(c.model)})`, c.ai, "Labels from Claude, checked by Baton") + metricRow("Rules + Claude", c.combined) : ""}
    </table></div>
    <p class="small muted" style="margin-top:10px">Per-type columns are F1. Honest caveats: our team wrote both the training and test sentences, so this is easier than real-world text. A 5-fold cross-validation on the training data gives a more conservative estimate of about 76% F1 for the AI. The independent second model is not used as a hard filter: on the training data that removed about a third of correct findings for ~2 points of precision, so its verdict is shown to the reviewer instead.</p>
    ${state.aiMode === "claude" ? `<p style="margin-top:10px"><button class="btn sm" data-act="claude-eval" ${ui.busy ? "disabled" : ""}>${ui.busy ? h(ui.busyText || "Working…") : "Score Claude on the same test set"}</button> <span class="small muted">Sends the ${TEST.length} test sentences to Anthropic with your key.</span></p>` : ""}
  </div>
  <div class="grid g2 section">
    <div class="card"><h3>Try any sentence</h3><p class="small muted" style="margin-top:4px">See what the rules and the AI make of it.</p>
      <div class="row" style="margin-top:10px;flex-wrap:nowrap"><input id="try-text" value="${h(ui.tryText || "")}" placeholder="Paste a sentence from your project"><button class="btn sm" data-act="ai-try">Check</button></div>
      ${
        tryRes
          ? `<table class="ledger" style="margin-top:10px"><tr><td>Rules</td><td><b>${h(tryRes.rule)}</b></td></tr><tr><td>Built-in AI</td><td><b>${h(tryRes.ai.label)}</b> · ${pct(tryRes.ai.p)} sure · ${tryRes.ai.accepted ? "would be added" : "not added (" + h(tryRes.ai.reason) + ")"}</td></tr><tr><td>Second model</td><td>${tryRes.ai.verified ? `<span class="pass">agrees</span>` : `<span class="fail">says ${h(tryRes.ai.verifierLabel)}</span>`}</td></tr></table>`
          : ""
      }
    </div>
    <div class="card"><h3>Found by AI, missed by rules</h3><p class="small muted" style="margin-top:4px">Examples from the test set.</p>
      <ul class="small" style="padding-left:18px;margin-top:8px">${miss.map((x) => `<li style="margin-bottom:6px">“${h(x.s)}” → <b>${h(x.ai)}</b></li>`).join("")}</ul>
    </div>
  </div>
  <details class="card flat section"><summary><b>All ${r.n} test sentences with each method’s answer</b></summary>
    <div style="overflow-x:auto"><table class="ledger" style="margin-top:10px;min-width:700px"><tr><th>Sentence</th><th>Correct</th><th>Rules</th><th>AI</th>${c ? "<th>Claude</th>" : ""}</tr>
    ${r.rows.map((x, i) => `<tr><td>${h(x.s)}</td><td>${x.gold}</td><td class="${x.rule === x.gold ? "pass" : "fail"}">${x.rule}</td><td class="${x.ai === x.gold ? "pass" : "fail"}">${x.ai}</td>${c ? `<td class="${c.rows[i].ai === x.gold ? "pass" : "fail"}">${c.rows[i].ai}</td>` : ""}</tr>`).join("")}</table></div></details>`;
}

/** Sentences Claude should label: the same ones the AI step looks at. */
function claudeTargets() {
  const out = [];
  for (const ev of D.evidence) {
    if (["branch", "issue"].includes(ev.kind) || ev.source === "testimony" || ev.meta?.code) continue;
    for (const sn of splitSentences(ev.text)) if (sn.split(/\s+/).length >= 4) out.push({ key: `${ev.id}|${sn}`, s: sn });
  }
  return out.slice(0, 300);
}

function pageCheck() {
  if (!state || state.kind !== "demo") return gate("", "The self-check scores the demo project. Load the demo first.", "Home");
  const t0 = performance.now();
  const r = selfCheck({ claims: D.claims, conflicts: D.conflicts, evidence: D.evidence, project: state.project, truth: LANTERN_TRUTH });
  const ms = Math.round(performance.now() - t0);
  const pass = r.results.filter((x) => x.pass).length;
  const groups = [...new Set(r.results.map((x) => x.group))];
  return `
  <div class="page-head"><div><p class="eyebrow">Self-check</p><h1 style="font-size:36px;margin-top:6px">${pass} of ${r.results.length} checks pass</h1>
  <p class="lede">Baton is scored live against the traps planted in Project Lantern. The leak test approves <b>every</b> claim first, then checks each role’s view — the worst case. Ran in ${ms} ms.</p></div></div>
  <div class="grid g3">
    <div class="card flat stat"><span class="v">${r.results.filter((x) => x.group.startsWith("Contradictions") && x.pass).length}/4</span><span class="k">contradictions flagged</span></div>
    <div class="card flat stat"><span class="v">${r.results.filter((x) => (x.group.startsWith("Missing") || x.group.startsWith("Recurring")) && x.pass).length}/5</span><span class="k">missing owners + recurring problems found</span></div>
    <div class="card flat stat"><span class="v">${r.citationIntegrity.exact}/${r.citationIntegrity.total}</span><span class="k">citations found word-for-word in their source</span></div>
  </div>
  <div class="card section"><table class="ledger"><tr><th>Check</th><th>Trap</th><th>Detail</th><th>Result</th></tr>
  ${groups.map((g) => r.results.filter((x) => x.group === g).map((x) => `<tr><td>${h(x.group)}</td><td class="mono">${h(x.id)}</td><td>${h(x.note)}</td><td class="${x.pass ? "pass" : "fail"}">${x.pass ? "Pass" : "Fail"}</td></tr>`).join("")).join("")}
  </table></div>
  <p class="small muted section">Note: this measures the demo data Baton was tuned on. On unfamiliar projects the pattern-based extraction will miss things — that is why every claim is labelled and reviewed by a person.</p>`;
}

function gate(to, msg, label = "Go to Connect") {
  return `<div class="card empty" style="max-width:560px;margin:40px auto"><p style="font-size:17px">${h(msg)}</p><p style="margin-top:16px"><a class="btn" href="#/${to}">${h(label)}</a></p></div>`;
}

function peopleOptions() {
  const set = new Set((state.people || []).map((p) => p.name));
  if (D) for (const e of D.evidence) if (e.author && e.source !== "testimony") set.add(e.author);
  return [...set].filter(Boolean).sort();
}

/* ---------- drawer ---------- */
function openEvidence(id, claimId) {
  const D = cx();
  const e = D.byId.get(id);
  if (!e) return;
  const quotes = D.claims
    .filter((c) => (claimId ? c.id === claimId : true))
    .flatMap((c) => c.citations.filter((x) => x.evidenceId === id).map((x) => x.quote));
  let html = h(e.text);
  for (const q of [...new Set(quotes)].sort((a, b) => b.length - a.length)) {
    const eq = h(q);
    if (eq && html.includes(eq) && !html.includes(`<mark>${eq}`)) html = html.replace(eq, `<mark>${eq}</mark>`);
  }
  const citing = D.claims.filter((c) => c.citations.some((x) => x.evidenceId === id));
  const dlg = $("#drawer");
  dlg.innerHTML = `<div class="in">
    <div class="row between"><p class="eyebrow">Source · ${h(SRC[e.source] || e.source)}</p><button class="btn sm ghost" data-act="close-drawer" aria-label="Close">Close ✕</button></div>
    <h2 id="drawer-title" style="font-size:22px">${h(e.ref)}</h2>
    <dl class="kv"><dt>Author</dt><dd>${h(e.author || "—")}</dd><dt>Date</dt><dd>${prettyDate(e.date)}</dd><dt>Visible to</dt><dd><span class="vis ${h(e.visibility)}">${h(VISIBILITY[e.visibility] || e.visibility)}</span></dd>${e.meta?.state ? `<dt>State</dt><dd>${h(e.meta.state)}${e.meta.assignee ? ` · assigned to ${h(e.meta.assignee)}` : " · unassigned"}</dd>` : ""}${e.url ? `<dt>Link</dt><dd><a href="${h(e.url)}" target="_blank" rel="noopener">Open on GitHub ↗</a></dd>` : ""}</dl>
    <blockquote>${html}</blockquote>
    <p class="small muted">Highlighted: the exact text the claim quotes. Secrets and contact details were masked before storage.</p>
    <h3>Claims citing this source (${citing.length})</h3>
    <div class="stack">${citing.map((c) => `<div class="small">${badge(c.label)} ${h(claimText(c))}</div>`).join("")}</div></div>`;
  if (!dlg.open) dlg.showModal();
}

/* ---------- render ---------- */
function render() {
  const { path, params } = route();
  viewing = path === "view";
  if (viewing) {
    const d = params.get("d") || "";
    renderChrome(path);
    if (!VD || VD.key !== d) {
      app.innerHTML = `<p class="empty">Opening the shared handover…</p>`;
      decodeShare(d)
        .then((obj) => {
          for (const [id, name] of Object.entries(obj.topics || {})) registerTopicName(id, name);
          VD = { ...obj, key: d, byId: new Map(obj.evidence.map((e) => [e.id, e])) };
          render();
        })
        .catch((e) => (app.innerHTML = `<div class="card empty" style="max-width:560px;margin:40px auto"><p>This share link can’t be opened: ${h(e.message)}. It may have been cut off when it was copied.</p><p style="margin-top:14px"><a class="btn" href="#/">Go to Baton</a></p></div>`));
      return;
    }
    app.innerHTML = pageView();
    return;
  }
  if (!state && path && path !== "") {
    location.hash = "#/";
    return;
  }
  if (path === "review" && params.get("tab")) ui.tab = params.get("tab");
  renderChrome(path);
  let html;
  switch (path) {
    case "connect": html = pageConnect(); break;
    case "reconstruct": html = pageReconstruct(); break;
    case "verify": html = pageVerify(); break;
    case "review": html = pageReview(params); break;
    case "handover": html = pageHandover(); break;
    case "check": html = pageCheck(); break;
    case "impact": html = pageImpact(); break;
    case "ai": html = pageAI(); break;
    default: html = state ? resumeHome() : pageHome();
  }
  app.innerHTML = html;
  if (path === "review" && ui.tab === "gaps" && state && !state.interview?.startedAt && D?.gaps?.length) {
    state.interview = addEffort(state.interview, Date.now());
    save(state);
  }
  const arc = document.getElementById("gauge-arc");
  if (arc) requestAnimationFrame(() => requestAnimationFrame(() => (arc.style.strokeDashoffset = arc.dataset.to)));
}

function resumeHome() {
  return `${pageHome()}<div class="card section row between"><div><h3>Continue: ${h(state.project.name)}</h3><p class="small muted">Your progress is saved in this browser.</p></div><a class="btn" href="#/connect">Continue →</a></div>`;
}

/* ---------- actions ---------- */
async function onAction(el, ev) {
  const act = el.dataset.act;
  const id = el.dataset.id;
  const now = new Date().toISOString();
  switch (act) {
    case "demo":
      state = demoState();
      save(state);
      derive();
      location.hash = "#/connect";
      break;
    case "custom":
      state = customState();
      save(state);
      derive();
      location.hash = "#/connect";
      break;
    case "reset":
      if (confirm(state.kind === "demo" ? "Reset the demo? Your answers and approvals will be cleared." : "Close this project? It will be removed from this browser.")) {
        state = null;
        save(null);
        derive();
        Object.assign(ui, { tab: "gaps", askRes: null, askQ: "", label: "all", type: "all", q: "" });
        location.hash = "#/";
        render();
      }
      break;
    case "ev":
      openEvidence(id, el.dataset.claim);
      break;
    case "close-drawer":
      $("#drawer").close();
      break;
    case "go-reconstruct":
      if (!state.project.leaver) {
        toast("Say who is leaving first.");
        $('[data-k="leaver"]')?.focus();
        return;
      }
      state.connected = true;
      commit({ who: "Team lead", action: "Connected sources", detail: `${D.evidence.length} evidence items; ${D.findings.filter((f) => f.kind === "secret").length} secret(s) removed; ${D.excluded.length} private channel(s) excluded` });
      location.hash = "#/reconstruct";
      break;
    case "gh-import": {
      const v = $("#gh-repo").value;
      ui.busy = true;
      render();
      try {
        const gh = await fetchGithubRepo(v);
        if (state.kind === "custom" && !state.sources.github) state.sources.github = gh;
        else state.sources.extraGithub = [...(state.sources.extraGithub || []).filter((g) => g.repo !== gh.repo), gh];
        ui.busy = false;
        commit({ who: "Team lead", action: "Imported GitHub repository", detail: gh.repo });
        const ni = gh.issues.filter((i) => !i.pull_request).length;
        const empty = !gh.pulls.length && !ni && !gh.commits.length && !gh.docs.length;
        toast(empty ? `${gh.repo} is public but has no issues, pull requests, commits or Markdown files to read.` : `Imported ${gh.repo}: ${gh.commits.length} commits, ${gh.docs.length} Markdown files, ${gh.pulls.length} PRs, ${ni} issues.`);
        if (!state.project.leaver && gh.commits.length) {
          const counts = {};
          for (const c of gh.commits) {
            const a = c.author?.login || c.commit?.author?.name;
            if (a) counts[a] = (counts[a] || 0) + 1;
          }
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
          if (top) {
            state.project.leaver = top[0];
            commit();
            toast(`Imported ${gh.repo}. “Who is leaving” was set to the most active committer, ${top[0]} — change it if needed.`);
          }
        }
        if (state.kind === "custom" && state.project.name === "My project") {
          state.project.name = gh.repo.split("/")[1];
          commit();
        }
      } catch (e) {
        ui.busy = false;
        render();
        toast(e.message);
      }
      break;
    }
    case "upload": {
      const files = [...($("#upload").files || [])];
      const vis = $("#upload-vis").value;
      if (!files.length) return toast("Choose one or more files first.");
      let added = 0;
      for (const f of files) {
        try {
          const text = await f.text();
          const p = parseUpload(f.name, text, vis);
          if (p.kind === "doc") state.sources.docs.push(p.value);
          else if (p.kind === "chat") state.sources.extraChats.push(p.value);
          else state.sources.extraGithub.push({ repo: f.name, ...p.value });
          added++;
        } catch (e) {
          toast(e.message);
        }
      }
      if (added) commit({ who: "Team lead", action: "Uploaded files", detail: files.map((f) => f.name).join(", ") + ` (${VISIBILITY[vis]})` });
      break;
    }
    case "rm-doc":
      state.sources.docs.splice(Number(el.dataset.i), 1);
      commit({ who: "Team lead", action: "Removed a document" });
      break;
    case "flabel":
      ui.label = el.dataset.v;
      render();
      break;
    case "tab":
      ui.tab = el.dataset.v;
      history.replaceState(null, "", `#/review?tab=${ui.tab}`);
      render();
      break;
    case "revfilter":
      ui.revFilter = el.dataset.v;
      render();
      break;
    case "answer":
    case "skip": {
      const g = D.gaps.find((x) => x.id === el.dataset.gap);
      const form = el.closest("[data-gapform]");
      const ans = { gap: { id: g.id, type: g.type, title: g.title, prompt: g.prompt }, at: today(), visibility: form.querySelector('[data-f="visibility"]')?.value || "team" };
      if (act === "skip") {
        ans.skipped = true;
      } else {
        ans.text = form.querySelector('[data-f="text"]')?.value.trim() || "";
        if (g.type === "conflict") {
          ans.choice = form.querySelector("input[type=radio]:checked")?.value;
          if (!ans.choice) return toast("Pick which option is current.");
        } else if (g.type === "owner" || g.type === "handoff") {
          ans.owner = form.querySelector('[data-f="owner"]').value.trim();
          if (!ans.owner) return toast("Name the new owner, or skip.");
        } else if (!ans.text) return toast("Write an answer, or skip.");
      }
      const before = D.impact.score;
      state.interview = addEffort(state.interview, Date.now());
      state.answers[g.id] = ans;
      commit({ who: state.project.leaver || "Leaver", action: act === "skip" ? "Skipped a gap question" : "Answered a gap question", detail: g.title + (ans.choice ? `: ${ans.choice}` : ans.owner ? `: ${ans.owner}` : "") });
      toast(act === "skip" ? "Skipped — it stays marked Missing." : `Saved as testimony. Handover readiness ${before} → ${D.impact.score}.`);
      break;
    }
    case "unanswer":
      delete state.answers[el.dataset.gap];
      commit({ who: state.project.leaver || "Leaver", action: "Withdrew an answer", detail: el.dataset.gap });
      break;
    case "approve":
    case "reject": {
      const c = D.claims.find((x) => x.id === id);
      const prev = state.reviews[id];
      state.reviews[id] = { ...(prev || {}), status: act === "approve" ? "approved" : "rejected", by: state.reviewer, at: now };
      commit({ who: state.reviewer, action: act === "approve" ? "Approved a claim" : "Rejected a claim", detail: claimText(c).slice(0, 90) });
      break;
    }
    case "unreview":
      delete state.reviews[id];
      commit({ who: state.reviewer, action: "Reset a claim to pending", detail: id });
      break;
    case "edit":
      ui.editing = id;
      render();
      $(`#edit-${CSS.escape(id)}`)?.focus();
      break;
    case "cancel-edit":
      ui.editing = null;
      render();
      break;
    case "save-edit": {
      const c = D.claims.find((x) => x.id === id);
      const text = $(`#edit-${CSS.escape(id)}`).value.trim();
      if (!text) return toast("The claim can’t be empty — reject it instead.");
      const prev = state.reviews[id];
      state.reviews[id] = { status: "approved", text, edited: text !== c.text, by: state.reviewer, at: now, history: [...(prev?.history || []), { at: now, from: prev?.text || c.text, to: text }] };
      ui.editing = null;
      commit({ who: state.reviewer, action: "Edited and approved a claim", detail: text.slice(0, 90) });
      break;
    }
    case "bulk-approve": {
      const list = D.claims.filter((c) => c.status === "active" && !state.reviews[c.id] && (c.label === "Verified" || c.label === "Single-source"));
      for (const c of list) state.reviews[c.id] = { status: "approved", by: state.reviewer, at: now, bulk: true };
      commit({ who: state.reviewer, action: "Bulk-approved claims", detail: `${list.length} Verified/Single-source claims` });
      toast(`Approved ${list.length} claims.`);
      break;
    }
    case "publish": {
      const active = D.claims.filter((c) => c.status === "active");
      const approved = active.filter((c) => state.reviews[c.id]?.status === "approved").length;
      const pending = active.filter((c) => !state.reviews[c.id]).length;
      if (pending && !confirm(`${pending} claim(s) are still pending and will be left out of version ${state.versions.length + 1}. Approve anyway?`)) return;
      const n = state.versions.length + 1;
      state.versions.push({ n, by: state.reviewer, at: now, approved, pending, readiness: D.impact.score, leaverMs: state.interview?.activeMs ?? null, spot: state.spot && Object.keys(state.spot).length ? spotAccuracy(state.spot) : null, reviews: JSON.parse(JSON.stringify(state.reviews)) });
      commit({ who: state.reviewer, action: `Approved handover version ${n}`, detail: `${approved} claims; ${pending} pending left out` });
      location.hash = "#/handover";
      toast(`Version ${n} approved and shared.`);
      break;
    }
    case "role":
      ui.role = el.dataset.v;
      ui.askRes = null;
      render();
      break;
    case "ask": {
      ui.askQ = $("#ask-q").value;
      const ho = currentHandover();
      ui.askRes = ask(ui.askQ, ho.ho, ho.reviews);
      render();
      break;
    }
    case "ack": {
      const name = $("#ack-name").value.trim();
      if (!name) return toast("Enter your name.");
      const v = latestVersion();
      state.acks.push({ name, role: ui.role, version: v.n, at: now });
      commit({ who: name, action: `Acknowledged receipt of v${v.n}`, detail: ROLES[ui.role].name + " view" });
      toast("Receipt recorded.");
      break;
    }
    case "export": {
      const { ho, evidence, reviews, v, project } = currentHandover();
      const md = toMarkdown(ho, evidence, reviews, v);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
      a.download = `handover-${project.name.toLowerCase().replace(/\W+/g, "-")}-${ho.role}-v${v.n}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }
    case "print":
      window.print();
      break;
    case "share": {
      const { ho, evidence, reviews, v, project } = currentHandover();
      const payload = sharePayload({ ho, evidence, reviews, project, version: v });
      payload.topics = Object.fromEntries(Object.keys(payload.topics).map((t) => [t, topicName(t)]));
      const token = await encodeShare(payload);
      ui.shareUrl = `${location.origin}${location.pathname}#/view?d=${token}`;
      ui.shareRole = ho.role;
      state.audit.push({ at: now, who: v.by, action: `Created a share link for the ${ho.roleName} view of v${v.n}`, detail: `${ho.list.length} claims` });
      save(state);
      render();
      break;
    }
    case "share-copy":
      try {
        await navigator.clipboard.writeText(ui.shareUrl);
        toast("Link copied. Anyone with it can read this view.");
      } catch {
        $("#share-url").select();
        toast("Press Ctrl+C to copy the selected link.");
      }
      break;
    case "quiz-start": {
      const { ho } = currentHandover();
      ui.quiz = { role: ho.role, key: ho.list.length, start: Date.now(), answers: {} };
      render();
      document.getElementById("quiz")?.scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    }
    case "quiz-submit": {
      const { ho, reviews, v } = currentHandover();
      const qs = buildQuiz(ho, reviews);
      const answers = {};
      for (const x of qs) answers[x.id] = document.querySelector(`input[name="q-${CSS.escape(x.id)}"]:checked`)?.value || null;
      const unanswered = qs.filter((x) => !answers[x.id]).length;
      if (unanswered && !confirm(`${unanswered} question(s) unanswered. Submit anyway?`)) return;
      const sc = scoreQuiz(qs, answers);
      const ms = Date.now() - ui.quiz.start;
      const name = $("#quiz-name")?.value.trim() || "";
      ui.quiz = { ...ui.quiz, answers, result: { ...sc, ms } };
      const rec = { name, role: ho.role, version: v.n, right: sc.right, total: sc.total, ms, at: now };
      if (viewing) {
        try {
          const all = JSON.parse(localStorage.getItem("baton:quiz:view") || "[]");
          all.push({ ...rec, key: VD.key });
          localStorage.setItem("baton:quiz:view", JSON.stringify(all.slice(-20)));
        } catch {}
        render();
      } else {
        state.quizzes = [...(state.quizzes || []), rec];
        commit({ who: name || "Successor", action: `Took the readiness check (${ROLES[ho.role].name} view, v${v.n})`, detail: `${sc.right}/${sc.total} in ${fmtDuration(ms)}` });
      }
      break;
    }
    case "quiz-close":
      ui.quiz = null;
      render();
      break;
    case "spot": {
      state.spot = { ...(state.spot || {}), [id]: el.dataset.v };
      commit({ who: state.reviewer, action: `Spot-checked a citation: ${el.dataset.v === "yes" ? "supports" : "does not support"} its claim` });
      break;
    }
    case "spot-reset":
      state.spot = {};
      state.spotSeed = (state.spotSeed || 1) + 1;
      commit({ who: state.reviewer, action: "Reset the citation spot-check" });
      break;
    case "ai-try":
      ui.tryText = $("#try-text").value.trim();
      render();
      break;
    case "claude-run":
    case "claude-eval": {
      ui.claudeKey = $("#claude-key")?.value ?? ui.claudeKey;
      ui.claudeModel = $("#claude-model")?.value.trim() || ui.claudeModel || "claude-haiku-5-5";
      if (!ui.claudeKey) {
        location.hash = "#/connect";
        return toast("Enter your Anthropic API key in the AI extraction card first.");
      }
      const targets = act === "claude-run" ? claudeTargets() : TEST.map(([s]) => ({ key: s, s }));
      ui.busy = true;
      ui.busyText = `Claude: 0 / ${targets.length}`;
      render();
      try {
        const labels = await labelWithClaude(targets.map((t) => t.s), {
          apiKey: ui.claudeKey,
          model: ui.claudeModel,
          onProgress: (d, n) => {
            ui.busyText = `Claude: ${d} / ${n}`;
            render();
          },
        });
        const map = Object.fromEntries(targets.map((t, i) => [t.key, labels[i]]));
        ui.busy = false;
        if (act === "claude-run") {
          state.llm = { model: ui.claudeModel, at: new Date().toISOString(), count: targets.length, labels: map };
          commit({ who: "Team lead", action: "Ran Claude extraction", detail: `${targets.length} sentences with ${ui.claudeModel}` });
          toast(`Claude labelled ${targets.length} sentences. Baton checked each one.`);
        } else {
          ui.claudeEval = { ...evaluate(TEST, map), model: ui.claudeModel };
          render();
        }
      } catch (e) {
        ui.busy = false;
        render();
        toast(e.message);
      }
      break;
    }
    case "impact-node":
      ev.preventDefault();
      ui.impactSel = ui.impactSel === id ? null : id;
      render();
      break;
    case "jump":
      ev.preventDefault();
      document.getElementById(`c-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      break;
  }
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT" || el.tagName === "INPUT" && el.type !== "button") return;
  onAction(el, ev);
});
document.addEventListener("change", (ev) => {
  const el = ev.target;
  const act = el.dataset?.act;
  if (!act) return;
  if (act === "proj") {
    state.project[el.dataset.k] = el.value.trim();
    commit();
  } else if (act === "doc-vis") {
    const d = state.sources.docs[Number(el.dataset.i)];
    d.visibility = el.value;
    commit({ who: "Team lead", action: "Changed document visibility", detail: `${d.name} → ${VISIBILITY[el.value]}` });
  } else if (act === "toggle-private") {
    state.sources.includePrivate = el.checked;
    commit({ who: "Team lead", action: el.checked ? "Allowed reading private channels (hidden from all views)" : "Excluded private channels" });
  } else if (act === "ftype") {
    ui.type = el.value;
    render();
  } else if (act === "ai-mode") {
    state.aiMode = el.value;
    commit({ who: "Team lead", action: "Changed AI extraction", detail: { off: "Off", local: "Built-in model", claude: "Claude (own key)" }[el.value] });
  } else if (act === "reviewer") {
    state.reviewer = el.value.trim() || "Reviewer";
    commit();
  }
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "claude-key") ui.claudeKey = ev.target.value;
  if (ev.target.id === "claude-model") ui.claudeModel = ev.target.value;
  if (ev.target.dataset?.act === "search") {
    ui.q = ev.target.value;
    const pos = ev.target.selectionStart;
    render();
    const s = $('[data-act="search"]');
    s.focus();
    s.setSelectionRange(pos, pos);
  }
});
document.addEventListener("keydown", (ev) => {
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList?.contains("inode")) {
    ev.preventDefault();
    onAction(ev.target, ev);
  }
  if (ev.key === "Enter" && ev.target.id === "try-text") onAction($('[data-act="ai-try"]'), ev);
  if (ev.key === "Enter" && ev.target.id === "ask-q") onAction($('[data-act="ask"]'), ev);
  if (ev.key === "Enter" && ev.target.id === "gh-repo") onAction($('[data-act="gh-import"]'), ev);
});
$("#drawer").addEventListener("click", (ev) => {
  if (ev.target.id === "drawer") ev.target.close();
});
window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});

derive();
render();
