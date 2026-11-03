// Ground truth for the 12 traps planted in Project Lantern.
// The in-app "Self-check" and the automated tests score Baton against this.

export const LANTERN_TRUTH = {
  contradictions: [
    { id: "auth", topic: "auth", note: "PR #42 moves auth to Supabase; 12 Sep notes keep auth on Firebase" },
    { id: "hosting", topic: "hosting", note: "Decision log says Vercel; chat says hosting moved to Netlify" },
    { id: "payments", topic: "payments", note: "Decision log says Razorpay; chat says Stripe test mode is live" },
    { id: "launch", topic: "launch", note: "Notes say 15 Nov; chat says 29 Nov" },
  ],
  missingOwners: [
    { id: "venue", issue: 80 },
    { id: "invoice", issue: 81 },
    { id: "a11y", issue: 84 },
  ],
  recurring: [
    { id: "ssl", issues: [31, 57, 88] },
    { id: "qr", issues: [45, 73] },
  ],
  // Strings that must NEVER appear in a developer's handover view.
  leaks: [
    { id: "api-key", needle: "SG.k9Xq2", kind: "secret in chat" },
    { id: "private-dm", needle: "Sneha", kind: "private direct message" },
    { id: "budget", needle: "45,000", kind: "leads-only budget note" },
  ],
};
