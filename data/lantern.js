// Project Lantern — a fully SYNTHETIC demo project (no real people or data).
// A student-club ticketing app. The tech lead, Arjun Mehta, leaves on 31 Oct 2026.
// The raw shapes mimic real exports: GitHub REST API objects, Markdown docs
// from a shared folder, and a Slack-style chat export.
// 12 traps are planted on purpose; see data/lantern-truth.js.

export const LANTERN = {
  project: {
    name: "Project Lantern",
    description: "Event ticketing web app for a college student club (synthetic demo data).",
    leaver: "Arjun Mehta",
    exitDate: "2026-10-31",
    today: "2026-10-30",
  },

  people: [
    { name: "Arjun Mehta", handle: "arjun", role: "Tech lead (leaving)" },
    { name: "Priya Nair", handle: "priya", role: "Club lead" },
    { name: "Karthik R", handle: "karthik", role: "Developer" },
    { name: "Divya S", handle: "divya", role: "Designer" },
  ],

  github: {
    repo: "sairam-club/lantern",
    pulls: [
      { number: 12, title: "Set up Next.js frontend and Vercel deploy", state: "closed", merged_at: "2026-07-08T10:00:00Z", created_at: "2026-07-06T09:00:00Z", updated_at: "2026-07-08T10:00:00Z", user: { login: "arjun" }, assignee: { login: "arjun" }, body: "We decided to deploy the frontend on Vercel because of preview deployments.", head: { ref: "setup-frontend" } },
      { number: 42, title: "Switch auth from Firebase to Supabase", state: "closed", merged_at: "2026-08-14T16:20:00Z", created_at: "2026-08-11T11:00:00Z", updated_at: "2026-08-14T16:20:00Z", user: { login: "arjun" }, assignee: { login: "arjun" }, body: "Moves login and sessions from Firebase Auth to Supabase Auth. Firebase is dropped from auth.", head: { ref: "supabase-auth" } },
      { number: 51, title: "Add QR ticket scanner", state: "closed", merged_at: "2026-08-28T12:00:00Z", created_at: "2026-08-25T12:00:00Z", updated_at: "2026-08-28T12:00:00Z", user: { login: "karthik" }, assignee: { login: "karthik" }, body: "Scanner page for volunteers at the door. Karthik owns the QR scanner.", head: { ref: "qr-scanner" } },
      { number: 64, title: "Razorpay checkout (draft)", state: "open", draft: true, merged_at: null, created_at: "2026-09-20T09:30:00Z", updated_at: "2026-10-06T09:30:00Z", user: { login: "arjun" }, assignee: { login: "arjun" }, body: "Checkout flow for paid tickets. Blocked by college IT: waiting on the Razorpay KYC approval and the live API key from the IT department.", head: { ref: "razorpay-checkout" } },
      { number: 70, title: "auth-refactor: move session refresh to middleware", state: "open", draft: false, merged_at: null, created_at: "2026-10-01T14:00:00Z", updated_at: "2026-10-08T18:00:00Z", user: { login: "arjun" }, assignee: { login: "arjun" }, body: "Half done. Session refresh works on web; the mobile app is not started.", head: { ref: "auth-refactor" } },
    ],
    issues: [
      { number: 31, title: "Deploy fails after SSL certificate renewal", state: "closed", created_at: "2026-08-01T08:00:00Z", closed_at: "2026-08-02T10:00:00Z", updated_at: "2026-08-02T10:00:00Z", user: { login: "karthik" }, assignee: { login: "arjun" }, labels: [{ name: "bug" }], body: "Build passes but the site serves a certificate error after certbot renewed the certificate. Fixed by restarting the proxy manually." },
      { number: 45, title: "QR scanner crashes on Android 12", state: "closed", created_at: "2026-08-30T08:00:00Z", closed_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z", user: { login: "divya" }, assignee: { login: "karthik" }, labels: [{ name: "bug" }], body: "The camera permission prompt crashes the scanner on Android 12 phones." },
      { number: 57, title: "Site down again after SSL certificate renewal", state: "closed", created_at: "2026-09-02T07:00:00Z", closed_at: "2026-09-03T09:00:00Z", updated_at: "2026-09-03T09:00:00Z", user: { login: "priya" }, assignee: { login: "arjun" }, labels: [{ name: "bug" }], body: "Same as #31. Restarted the proxy again by hand." },
      { number: 73, title: "QR scanner crashes on Android 12 again", state: "open", created_at: "2026-09-25T08:00:00Z", closed_at: null, updated_at: "2026-09-26T08:00:00Z", user: { login: "divya" }, assignee: { login: "karthik" }, labels: [{ name: "bug" }], body: "The crash came back after the camera library update." },
      { number: 80, title: "Venue booking confirmation for launch", state: "open", created_at: "2026-10-02T09:00:00Z", closed_at: null, updated_at: "2026-10-02T09:00:00Z", user: { login: "priya" }, assignee: null, labels: [{ name: "ops" }], body: "We need written confirmation of the auditorium booking from the Events Office." },
      { number: 81, title: "Sponsor invoice follow-up", state: "open", created_at: "2026-10-02T09:10:00Z", closed_at: null, updated_at: "2026-10-02T09:10:00Z", user: { login: "priya" }, assignee: null, labels: [{ name: "ops" }], body: "The sponsor says they have not received the invoice." },
      { number: 84, title: "Accessibility audit of checkout", state: "open", created_at: "2026-10-03T11:00:00Z", closed_at: null, updated_at: "2026-10-03T11:00:00Z", user: { login: "divya" }, assignee: null, labels: [{ name: "a11y" }], body: "Checkout has not been tested with a screen reader." },
      { number: 88, title: "SSL certificate renewal broke deploy (third time)", state: "open", created_at: "2026-10-04T06:00:00Z", closed_at: null, updated_at: "2026-10-04T06:00:00Z", user: { login: "karthik" }, assignee: { login: "arjun" }, labels: [{ name: "bug" }], body: "The certificate renewed overnight and the site was down until a manual restart." },
      { number: 90, title: "Push notifications for ticket reminders", state: "open", created_at: "2026-10-10T10:00:00Z", closed_at: null, updated_at: "2026-10-12T10:00:00Z", user: { login: "arjun" }, assignee: { login: "arjun" }, labels: [{ name: "feature" }], body: "Uses Firebase Cloud Messaging. Depends on the Firebase project staying active." },
    ],
    branches: [
      { name: "main", last_commit: "2026-10-20T10:00:00Z", author: "karthik" },
      { name: "auth-refactor", last_commit: "2026-10-08T18:00:00Z", author: "arjun" },
      { name: "razorpay-checkout", last_commit: "2026-10-06T09:30:00Z", author: "arjun" },
    ],
  },

  docs: [
    {
      name: "Decision log.md",
      visibility: "team",
      modified: "2026-08-10",
      author: "Arjun Mehta",
      body: `# Decision log

## 2026-07-05 Hosting
Decision: Deploy the frontend on Vercel. Owner: Arjun Mehta.

## 2026-07-20 Payments
Decision: Use Razorpay for ticket payments because it supports UPI. Owner: Arjun Mehta.

## 2026-08-10 Auth
Decision: Switch auth to Supabase to cut Firebase costs. Owner: Arjun Mehta.`,
    },
    {
      name: "Meeting notes 2026-09-12.md",
      visibility: "team",
      modified: "2026-09-12",
      author: "Priya Nair",
      body: `# Weekly meeting, 12 Sep 2026
Attendees: Priya Nair, Arjun Mehta, Karthik R, Divya S

- Firebase stays for push notifications.
- Auth stays on Firebase until the mobile app update ships.
- Launch on 15 Nov 2026 in the main auditorium.
- Action: Divya to finish the ticket design by 30 Sep.
- Open question: Do we need a refund policy before launch?`,
    },
    {
      name: "Meeting notes 2026-10-10.md",
      visibility: "team",
      modified: "2026-10-10",
      author: "Priya Nair",
      body: `# Weekly meeting, 10 Oct 2026
Attendees: Priya Nair, Arjun Mehta, Karthik R

- Arjun will hand over by 31 Oct.
- Karthik owns the QR scanner.
- Risk: Razorpay KYC may not clear before launch.
- Open question: Who confirms the venue with the Events Office?`,
    },
    {
      name: "Contacts.md",
      visibility: "team",
      modified: "2026-09-01",
      author: "Arjun Mehta",
      body: `# Contacts
- Contact: Ms. Lakshmi, Events Office, lakshmi.events@college.example, +91 98765 43210 — venue bookings.
- Contact: Rahul K, IT department — Razorpay KYC and live API keys.
- Contact: Mr. Varun, BrightPath Tutorials — sponsor.`,
    },
    {
      name: "Budget.md",
      visibility: "leads",
      modified: "2026-10-05",
      author: "Priya Nair",
      body: `# Budget (CONFIDENTIAL — leads only)
- Sponsor contribution from BrightPath Tutorials is Rs 45,000.
- Venue deposit of Rs 8,000 was paid by Priya.
- Risk: The sponsor payment depends on sending the invoice before 15 Nov.`,
    },
  ],

  chat: {
    workspace: "lantern-club",
    channels: [
      {
        name: "dev",
        is_private: false,
        visibility: "team",
        messages: [
          { user: "arjun", ts: "2026-09-22T10:05:00Z", text: "Heads up, we moved hosting to Netlify last week because the Vercel build minutes ran out." },
          { user: "karthik", ts: "2026-09-23T09:00:00Z", text: "Is Razorpay live yet?" },
          { user: "arjun", ts: "2026-09-23T09:12:00Z", text: "No. Payments run on Stripe test mode right now; Razorpay KYC is still pending with college IT." },
          { user: "arjun", ts: "2026-09-24T15:40:00Z", text: "Here's the SendGrid key for the email receipts: SG.k9Xq2LmP4vR8sT1uW3yZ5a.B7cD9eF0gHiJ2kL4mN6oP8qR0sT" },
          { user: "karthik", ts: "2026-10-14T11:00:00Z", text: "Who has the Events Office contact? I can't find it." },
          { user: "arjun", ts: "2026-10-15T12:30:00Z", text: "I'll look at the SSL renewal issue, the proxy probably needs a restart hook after certbot runs." },
          { user: "divya", ts: "2026-10-20T16:00:00Z", text: "Ticket design is done and pushed to Figma." },
          { user: "arjun", ts: "2026-10-21T10:00:00Z", text: "Payments are blocked until college IT sends the live Razorpay key." },
        ],
      },
      {
        name: "general",
        is_private: false,
        visibility: "team",
        messages: [
          { user: "priya", ts: "2026-10-12T18:00:00Z", text: "Launch moved to 29 Nov 2026 because the auditorium is booked on the 15th." },
          { user: "priya", ts: "2026-10-25T09:00:00Z", text: "Arjun's last day is 31 Oct. Please send him your questions this week." },
        ],
      },
      {
        name: "dm-arjun-priya",
        is_private: true,
        visibility: "private",
        messages: [
          { user: "arjun", ts: "2026-10-18T21:00:00Z", text: "Keeping this between us: Sneha asked to step back from the club for personal health reasons." },
        ],
      },
    ],
  },
};
