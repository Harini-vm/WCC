# Baton — handovers that prove themselves

**Team FlyHigh · Sri Sairam Engineering College · Round 2 build**

When someone leaves a project, Baton rebuilds what they knew from the project's own GitHub, documents and chat. Every statement links to the exact source text, every doubt is labelled, the person leaving answers only the gaps, and each successor sees only what their role is allowed to see.

**Live app:** https://harini-vm.github.io/baton/  ·  **Code:** https://github.com/Harini-vm/WCC → click **Try the demo project**.

No sign-in, no install, no server. Everything runs in the browser, and data stays in that browser (localStorage).

---

## Try it in 3 minutes (judges)

1. Open the live link and click **Try the demo project**. It loads *Project Lantern*, a synthetic student-club app whose tech lead leaves on 31 Oct.
2. **Connect.** Notice that the SendGrid API key pasted in chat was removed on arrival, the private DM is excluded, and `Budget.md` is *Leads only*. Click **Reconstruct the project**.
3. **Reconstruct.** Shows 39 claims with a timeline. Click any grey source chip to see the exact quoted text highlighted in its source.
4. **Verify.** Shows 50 citations checked and 4 conflicts placed side by side (hosting, payments, auth, launch date).
5. **Review → Gap interview.** You play the leaver. Answer a conflict (for example, launch date = 29 Nov) and assign an owner to an unowned task. Each answer becomes signed *testimony* and the ledger updates.
6. **Review → Approve claims.** You play the reviewer. Click **Approve all Verified + Single-source**, approve or edit a few others, then click **Approve version 1**.
7. **Handover.** Switch between **Developer** and **Club lead** views. Ask “What is the budget?” in each. The developer gets *“doesn’t answer this”* and the lead gets the cited figure. Click **I’ve read it** to record receipt.
8. **Impact map** (amber button, top right) shows everything tied to the leaver and a live **Handover Readiness Score**. It starts at 20/100 on the demo and rises as you answer the gap interview.
9. Open **AI vs rules** (top right): the measured comparison on held-out sentences, and a box to test any sentence yourself.
10. In **Handover**, take the **Readiness check** (10 questions generated from the approved handover) and click **Create share link**. Open the link in a private window: the read-only handover loads with no account and no server.
11. **Self-check** (top right) scores Baton live against the 12 planted traps.

To try your own data, click **Use your own sources** and upload the files in [`examples/`](examples/), or import any public GitHub repo (`owner/repo`).

## What works (Round 2)

| Step | Working now |
|---|---|
| Connect | GitHub export + **live public-repo import**: issues, PRs, branches, the last 50 commits and up to 8 Markdown files (READMEs, docs) · Markdown/TXT docs · Slack-style JSON, JSON-array and WhatsApp chat exports · per-source visibility (Whole team / Leads only) · private channels excluded by default · secret and contact redaction on arrival |
| Reconstruct | What the project is, how to run it and key facts (from READMEs) · recent changes and knowledge concentration (from commits) · numeric contradictions (e.g. “90%” vs “98%” accuracy) · typed claims: decisions, owners, missing owners, dependencies, risks, recurring problems, open questions, next actions, contacts, budget facts, progress · idle-branch detection · decision timeline |
| Verify | Exact-quote citation check plus a topic/term support check · conflict detection (same topic, different choice or date) · five evidence-based labels: Verified, Single-source, Inferred, Conflicting, Missing |
| Review | Risk-ranked **Gap Interview** (conflicts, missing owners, leaver’s open work, recurring problems, unanswered questions) · answers stored as dated, attributed testimony · approve / edit / reject each claim · bulk approve · versioned sign-off · audit log |
| AI extraction | A **built-in AI model**, trained by us and shipped with the app, reads the sentences no rule recognised and finds decisions, risks, blockers, questions and tasks however they are worded. It runs offline in the browser. A **second, independently built model** (character patterns only) gives its own verdict on every AI finding. AI findings keep their exact quote, are labelled Inferred and must be approved one by one · optional **Claude mode** with your own Anthropic key, still checked by Baton · **AI vs rules page**: measured on a held-out test set (rules F1 44% → rules + AI F1 87%, precision 96%) |
| Exit Impact Map | Every piece of knowledge tied to the leaver (work they own, unowned work, disputed decisions, repeat problems, unanswered questions, unfinished branches, things only they said), each marked secured / partly secured / at risk · weighted **Handover Readiness Score** (0–100) that updates live as gaps are closed · interactive map showing who each item was handed to · readiness recorded on every approved version |
| Round 1 commitments | **Share link**: one role's approved view compressed into the link itself (after `#`, never uploaded), opens read-only anywhere · **Leaver effort** timer for the gap interview (target ≤ 20 min, pauses over 5 min capped) · **Readiness check**: 10 multiple-choice questions generated from the approved view, scored and timed · **Citation spot-check**: reviewer marks sampled citations supports / doesn’t, giving a measured accuracy (target ≥ 95%) · **Rejected options** kept, struck through, in the decision timeline · all four numbers are stamped on each approved version |
| Handover | Role views (Developer, Club lead) · “Where things stand” · first-72-hours plan · Q&A limited to approved, permitted claims · Markdown export · print/PDF · acknowledgement of receipt |

## How it works

```
sources ─► ingest (normalise + tag visibility + REDACT) ─► evidence
evidence ─► extract (sentence rules + GitHub state) ─► candidate claims
claims ─► verify (exact quote + support check, merge, conflicts, labels) ─► Claim Ledger
ledger ─► Gap Interview ─► testimony evidence ─► re-verify
ledger ─► reviewer approves version N (snapshot) ─► role filter ─► handover
```

* **No citation, no claim.** A claim is created only from a sentence in the evidence, and the sentence is stored as its quote. The verifier drops any citation whose quote is not found word-for-word in its source, or (for decisions) does not mention the claim’s topic or choice.
* **Labels come from evidence.** Two or more independent source types agree, or a person confirmed it → *Verified*. One source → *Single-source*. Pattern-based (similar issues, idle branch) → *Inferred*. Same topic with a different choice → *Conflicting*. Expected but absent → *Missing*.
* **Permissions by construction.** Every evidence item carries a visibility. A claim reaches a role only if **every** source it cites is visible to that role. Private channels are visible to no role. A structural leak check runs on every handover view.
* **Secrets never stored.** API keys, tokens, emails and phone numbers are masked during ingestion, so the original value never exists in the app’s state.
* **Readiness is measured, not claimed.** The Exit Impact Map turns the ledger into knowledge units weighted by risk (1–3). The score is the share that is secured (1) or partly secured (½). On the demo it goes from 20 before the gap interview to 92 after it. The last 8 points are statements only the leaver ever made, and Baton will not mark them verified on its own.
* **Humans hold the last gate.** Only claims approved in a signed version reach the successor. Later edits do not change what was shared until a new version is approved.

### Code map

| Path | What it does |
|---|---|
| `js/engine/ingest.js` | GitHub/doc/chat/upload parsers, live GitHub import |
| `js/engine/redact.js` | Secret and personal-data masking |
| `js/engine/analyze.js` | Extraction, citation checks, conflicts, labels, Gap Interview |
| `js/engine/impact.js` | Exit impact units, readiness score, map layout |
| `js/engine/ml.js`, `js/engine/ml-model.js` | Built-in AI: extractor (logistic regression on words, phrases and cues) + independent verifier (character n-grams); weights generated by `scripts/train.mjs` |
| `js/engine/eval.js`, `data/ml-train.js`, `data/ml-test.js` | Rules vs AI evaluation; 275 training and 120 held-out test sentences |
| `js/engine/llm.js` | Optional Claude labelling with the user's own key |
| `js/engine/extras.js` | Readiness quiz, citation sampling, leaver-effort accounting |
| `js/share.js` | Share-link encoding (deflate + base64url) and the role-limited payload |
| `js/engine/handover.js` | Role filtering, leak check, 72-hour plan, Q&A, Markdown export |
| `js/engine/pipeline.js` | Glue plus self-check against ground truth |
| `js/main.js`, `css/app.css` | The interface (no framework, no build step) |
| `data/lantern.js`, `data/lantern-truth.js` | Synthetic demo project and its 12 planted traps |
| `tests/engine.test.mjs` | 27 automated tests |

## Run locally

```bash
python3 -m http.server 8080        # then open http://localhost:8080
npm test                           # Node 18+; runs 27 engine tests
node scripts/train.mjs             # retrain the built-in AI model from data/ml-train.js
```

## Changes from the Round 1 plan

* **The backend was replaced by a browser-only app.** FastAPI, Postgres and server-side LLM calls were swapped for plain ES modules running in the browser. Judges get a link that works with no sign-in, and no project data leaves the browser. Row-level security became an equivalent rule enforced in code (every cited source must be visible to the role) and is covered by tests.
* **Extraction is rules + a built-in AI model instead of a hosted LLM.** The AI model was trained by us and runs offline in the browser, so it needs no API key and judges can use it. Claude can be used with your own key. AI findings are always labelled Inferred and reviewed by a person.
* **The NLI entailment model became an independent second model.** It is a separately built classifier that gives its own verdict on each AI finding, plus the exact-quote check. Its agreement is measured: 99% precision when both agree, 89% when it disagrees.
* **Added:** the Exit Impact Map with a live Handover Readiness Score, live GitHub import, a self-check scored against ground truth, budget facts, idle-branch detection, and Q&A over the approved handover.

## Known limitations

* The built-in AI is a small model trained on 275 sentences that our team wrote, and the test set was written by our team too, so real-world accuracy will be lower than the test score. 5-fold cross-validation estimates about 76% F1. On READMEs and our demo, the rules already cover most sentences, so the AI adds only a few findings. It helps most on free-form chat and notes.
* Claude mode needs your own Anthropic API key, and your sentences are sent to Anthropic. It was tested against the live API's error responses and a mocked success, but not with a paid key.
* Rule-based extraction is tuned on the demo project. On unfamiliar writing it will miss claims (low recall), though anything it does extract is cited.
* Conflict detection covers known topics (hosting, auth, payments, push notifications, launch date, database) and named providers.
* GitHub import is public repositories only and unauthenticated (60 requests/hour). No live Slack, Drive or Discord connection yet; use exports.
* A share link is a snapshot of one approved version: it can't be revoked, and anyone who has it can read that view. Readiness-check results taken from a share link stay in that reader's browser.
* State is per browser. There are no accounts, so “reviewer”, “leaver” and “successor” are roles you switch between, not separate logins.

## Round 3 commitments

1. **Live Slack and Discord connector with an in-chat gap interview.** Baton reads channels live with per-channel permissions, and a Baton bot DMs the leaver the gap questions where they already work. Answers flow straight back as testimony. Measured by the share of gaps answered and the leaver's minutes.
2. **Real accounts and permissions.** Sign-in, a server with per-role access enforced in the database, shareable handover links, and OAuth connectors for GitHub (including private repos) and Google Drive.
3. **Living handover and bus-factor radar.** Incremental re-sync that shows what changed since the last approved version, and a risk view that flags areas where knowledge sits with one person before anyone leaves.

---
All demo data is synthetic. MIT licence.
