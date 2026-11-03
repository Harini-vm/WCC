// Small shared helpers. Pure functions, no DOM, so the engine runs in Node tests too.

export function hash(str) {
  // FNV-1a 32-bit -> short base36 id. Stable across runs, so review state survives re-analysis.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const ABBREV = /\b(Mr|Ms|Mrs|Dr|St|vs|e\.g|i\.e|etc)\./g;

/**
 * Split text into sentences, returning exact substrings of the input.
 * A sentence ends at . ! or ? only when followed by whitespace or the end, so URLs,
 * file names and version numbers (vercel.com/new?x, app.py, v1.2) stay whole.
 */
export function sentences(text) {
  if (!text) return [];
  const masked = text.replace(ABBREV, (m) => m.replace(/\./g, "\u0000"));
  const out = [];
  const re = /[^\n]+?(?:[.!?]+(?=\s|$)|$)/gm;
  let m;
  while ((m = re.exec(masked))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const raw = m[0];
    const start = m.index + (raw.length - raw.trimStart().length);
    const piece = text.slice(start, m.index + raw.length).trim();
    if (piece.replace(/[^A-Za-z0-9]/g, "").length >= 3) out.push(piece);
  }
  return out;
}

const STOP = new Set(
  "a an the and or but of to in on at for from by with is are was were be been it its this that these those as after before again same third time times than then there here we our you your i he she they them his her not no yes do does did has have had will would can could should may might just very into over under up down out about via per when while".split(" ")
);

export function stem(w) {
  return w
    .replace(/(ing|ed|es)$/, "")
    .replace(/s$/, "")
    .replace(/(ies)$/, "y");
}

export function tokens(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && w.length > 1)
    .map(stem);
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

export function isoDate(d) {
  if (!d) return null;
  const s = String(d);
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function prettyDate(iso) {
  if (!iso) return "undated";
  const [y, mo, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

export function daysBetween(aIso, bIso) {
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / 86400000);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
