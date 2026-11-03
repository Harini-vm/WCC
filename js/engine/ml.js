// Baton's built-in AI extraction: two small, independently built text classifiers.
//
//  Extractor  — multinomial logistic regression over word unigrams, bigrams and cue features.
//  Verifier   — a second, independently built model over character 3–5-grams only (no words,
//               no cue rules), so it fails in different ways from the extractor.
//
// A sentence becomes an AI claim when the extractor is ≥ 60% confident (threshold chosen by
// 5-fold cross-validation on the training data, never on the test set). The verifier then gives
// a second opinion: "agrees" if the extractor's label is in its top two. Cross-validation showed
// that using the verifier as a hard filter removes ~1/3 of correct findings for ~2 points of
// precision, so instead its verdict is shown to the reviewer and measured separately.
// Weights are trained by scripts/train.mjs and shipped in ml-model.js; everything runs offline.

import { MODEL } from "./ml-model.js";

export const ML_LABELS = ["decision", "risk", "dependency", "question", "action", "none"];

const IMPERATIVE = new Set("add update send fix remove deploy write book ask follow make please record migrate archive hand cancel compress return upload set rotate tune collect email schedule prepare renew review test move create check confirm clean finish install configure document plan submit draft call buy order print share".split(" "));
const WH = new Set("who what where which when why how does do did is are can could should has have will would any".split(" "));
const DECIDED = /\b(went with|go(?:ing)? with|settled|agreed|decided|chose|chosen|opted|picked|finali[sz]ed|switched|swapped|moved|migrated|replaced|dropped|ditched|scrapped|abandoned|reverted|stopped using|no longer|from now on|going forward|final call|our call|of choice|fixed (?:at|for)|locked|approved|signed off|voted)\b/i;
const RISKY = /\b(worried|concern|risk|risky|danger|might|may|could|chance|crash\w*|fail\w*|break\w*|broke|down|vulnerab\w*|leak\w*|expos\w*|unsafe|flaky|overfit\w*|slow|timeout\w*|over budget|below target|no backup|no fallback|no rollback|only (?:one|copy)|nobody else|plain text|overheat\w*|run(?:s|ning)? out|expire\w*|dropping|cutting it close|confused|gamed)\b/i;
const BLOCKED = /\b(blocked|block(?:ing|s)?|waiting|wait(?:s)? (?:on|for)|awaits?|on hold|held up|stuck|depends?|dependent|hinges?|relies?|rely|requires?|pending|until|till|before we can|can't (?:go|launch|start|merge)|cannot|can only|once)\b/i;
const TODO = /\b(todo|action(?: item)?|to do|next (?:step|up)|need to|needs to|have to|has to|must|should|remember|don't forget|make sure|please|i'll|i will|will|going to|planning to|plan for|someone (?:has|should|needs))\b/i;

function words(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s?]/g, " ")
    .replace(/\?/g, " ? ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/(ing|ed|es|s)$/, "") || w);
}

/** Sparse feature list for the extractor. */
export function featuresOf(text) {
  const t = String(text || "").trim();
  const w = words(t);
  const f = new Set(["bias"]);
  for (const x of w) f.add("w:" + x);
  for (let i = 0; i + 1 < w.length; i++) f.add("b:" + w[i] + "_" + w[i + 1]);
  const first = (t.match(/^[A-Za-z']+/) || [""])[0].toLowerCase();
  if (t.endsWith("?")) f.add("c:endq");
  if (WH.has(first)) f.add("c:wh_start");
  if (IMPERATIVE.has(first)) f.add("c:imperative");
  if (/^[A-Z][a-z]+ (to|will|is going to|should|is setting)\b/.test(t)) f.add("c:person_task");
  if (DECIDED.test(t)) f.add("c:decided");
  if (RISKY.test(t)) f.add("c:risky");
  if (BLOCKED.test(t)) f.add("c:blocked");
  if (TODO.test(t)) f.add("c:todo");
  if (/\b(not|no|never|n't|nobody|none)\b/i.test(t)) f.add("c:neg");
  if (/\b(we|we're|we'll|let's|our|team)\b/i.test(t)) f.add("c:we");
  if (/(\brs\.?|₹|\$|\brupees?)\s?\d|\d\s?(rupees|k\b)/i.test(t)) f.add("c:money");
  if (/\b\d{1,2}(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|weekend|next week)\b/i.test(t)) f.add("c:date");
  if (/\d\s?%|percent/i.test(t)) f.add("c:pct");
  if (/^[A-Z][a-z]+(:|\s—)/.test(t)) f.add("c:label_prefix");
  if (w.length <= 4) f.add("c:short");
  if (/^(unclear|not sure|not clear|still unknown|tbd|open question|nobody knows|we still don't know|it is not decided)/i.test(t)) f.add("c:unknown");
  return [...f];
}

/** Character n-grams for the verifier. */
export function charGrams(text) {
  const s = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9?' ]/g, " ").replace(/\s+/g, " ").trim()} `;
  const out = [];
  for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** Extractor probabilities per label. */
export function extractorProbs(text, model = MODEL) {
  const z = new Array(ML_LABELS.length).fill(0);
  for (const f of featuresOf(text)) {
    const w = model.extractor[f];
    if (w) for (let k = 0; k < z.length; k++) z[k] += w[k];
  }
  return softmax(z);
}

/** Verifier probabilities per label (character-gram logistic regression). */
export function verifierProbs(text, model = MODEL) {
  const z = new Array(ML_LABELS.length).fill(0);
  for (const g of new Set(charGrams(text))) {
    const w = model.verifier[g];
    if (w) for (let k = 0; k < z.length; k++) z[k] += w[k];
  }
  return softmax(z);
}

const argmax = (a) => a.indexOf(Math.max(...a));

/**
 * Classify one sentence.
 *  accepted — the extractor's label is not "none" and it is ≥ minP confident (or a label was
 *             proposed by another extractor, e.g. Claude).
 *  verified — the independent verifier ranks the same label in its top two.
 */
export function classify(text, { minP = 0.6, proposed = null, model = MODEL } = {}) {
  const p = extractorProbs(text, model);
  const v = verifierProbs(text, model);
  const label = proposed || ML_LABELS[argmax(p)];
  const k = ML_LABELS.indexOf(label);
  const top2 = v.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map((x) => ML_LABELS[x[1]]);
  const confident = proposed ? true : p[k] >= minP;
  const verified = top2.includes(label);
  return {
    label,
    p: Math.round(p[k] * 100) / 100,
    v: Math.round(v[k] * 100) / 100,
    verifierLabel: top2[0],
    accepted: label !== "none" && confident,
    verified,
    reason: label === "none" ? "nothing to extract" : !confident ? "low confidence" : verified ? "accepted · second model agrees" : `accepted · second model disagrees (said ${top2[0]})`,
  };
}

/** Precision / recall / F1 per label and micro-averaged over the five extractable labels. */
export function scorePredictions(gold, pred) {
  const labels = ML_LABELS.filter((l) => l !== "none");
  const per = {};
  let TP = 0, FP = 0, FN = 0;
  for (const l of labels) {
    let tp = 0, fp = 0, fn = 0;
    gold.forEach((g, i) => {
      if (pred[i] === l && g === l) tp++;
      else if (pred[i] === l && g !== l) fp++;
      else if (g === l && pred[i] !== l) fn++;
    });
    TP += tp; FP += fp; FN += fn;
    const P = tp + fp ? tp / (tp + fp) : 0, R = tp + fn ? tp / (tp + fn) : 0;
    per[l] = { precision: P, recall: R, f1: P + R ? (2 * P * R) / (P + R) : 0, support: tp + fn };
  }
  const P = TP + FP ? TP / (TP + FP) : 0, R = TP + FN ? TP / (TP + FN) : 0;
  return { per, micro: { precision: P, recall: R, f1: P + R ? (2 * P * R) / (P + R) : 0, tp: TP, fp: FP, fn: FN } };
}
