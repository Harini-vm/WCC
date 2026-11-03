// Persistence: everything stays in this browser (localStorage). No server, no tracking.
import { LANTERN } from "../data/lantern.js";

const KEY = "baton:v1";

const clone = (x) => JSON.parse(JSON.stringify(x));

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function demoState() {
  const L = clone(LANTERN);
  return {
    kind: "demo",
    project: L.project,
    people: L.people,
    sources: { github: L.github, docs: L.docs, chat: L.chat, extraChats: [], extraGithub: [], includePrivate: false },
    connected: false,
    answers: {},
    reviews: {},
    audit: [{ at: new Date().toISOString(), who: "System", action: "Demo project loaded", detail: "Project Lantern (synthetic data)" }],
    versions: [],
    acks: [],
    reviewer: "Priya Nair",
  };
}

export function customState() {
  return {
    kind: "custom",
    project: { name: "My project", description: "", leaver: "", exitDate: today(), today: today() },
    people: [],
    sources: { github: null, docs: [], chat: null, extraChats: [], extraGithub: [], includePrivate: false },
    connected: false,
    answers: {},
    reviews: {},
    audit: [{ at: new Date().toISOString(), who: "System", action: "New project started", detail: "" }],
    versions: [],
    acks: [],
    reviewer: "Reviewer",
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(state) {
  try {
    if (state) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage full or blocked: the app still works for this session */
  }
}
