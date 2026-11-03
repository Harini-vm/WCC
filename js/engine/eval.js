// Rules vs AI on the held-out test set (data/ml-test.js).
import { ruleTypeOf } from "./analyze.js";
import { classify, scorePredictions } from "./ml.js";

/**
 * @param test   [[sentence, goldLabel], ...]
 * @param ai     optional map sentence -> proposed label (e.g. from Claude); verified locally.
 */
export function evaluate(test, ai = null) {
  const gold = test.map(([, l]) => l);
  const rows = test.map(([s, g]) => {
    const rule = ruleTypeOf(s);
    const c = classify(s, ai ? { proposed: ai[s] || "none" } : {});
    const aiLabel = c.accepted ? c.label : "none";
    return { s, gold: g, rule, ai: aiLabel, aiVerified: c.accepted && c.verified ? c.label : "none", aiUnverified: c.accepted && !c.verified ? c.label : "none", combined: rule !== "none" ? rule : aiLabel, why: c.reason, p: c.p, v: c.v, verified: c.verified };
  });
  return {
    n: test.length,
    rows,
    rules: scorePredictions(gold, rows.map((r) => r.rule)),
    ai: scorePredictions(gold, rows.map((r) => r.ai)),
    aiVerified: scorePredictions(gold, rows.map((r) => r.aiVerified)),
    aiUnverified: scorePredictions(gold, rows.map((r) => r.aiUnverified)),
    combined: scorePredictions(gold, rows.map((r) => r.combined)),
  };
}
