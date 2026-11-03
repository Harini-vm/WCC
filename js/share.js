// Share links: the approved handover for ONE role is compressed into the link itself (after #),
// so it can be opened anywhere without a server. The part after # is never sent to any server.

function toB64Url(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(str) {
  const b = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export async function encodeShare(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") return "j." + toB64Url(json);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return "z." + toB64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function decodeShare(token) {
  try {
    return await decodeInner(token);
  } catch (e) {
    throw new Error(/Baton handover/.test(e.message) ? e.message : "the link is incomplete or damaged");
  }
}

async function decodeInner(token) {
  const [kind, data] = [token.slice(0, 2), token.slice(2)];
  const bytes = fromB64Url(data);
  let json;
  if (kind === "j.") json = new TextDecoder().decode(bytes);
  else if (kind === "z.") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    json = await new Response(stream).text();
  } else throw new Error("Unknown link format");
  const obj = JSON.parse(json);
  if (obj?.v !== 1 || !Array.isArray(obj.claims)) throw new Error("This link is not a Baton handover.");
  return obj;
}

/** Only what this role's approved view contains: its claims and the evidence they cite. */
export function sharePayload({ ho, evidence, reviews, project, version }) {
  const claims = ho.list.concat(ho.sections.rejected || []);
  const ids = new Set(claims.flatMap((c) => c.citations.map((x) => x.evidenceId)));
  const ev = evidence.filter((e) => ids.has(e.id)).map(({ id, source, kind, ref, title, text, author, date, visibility, url, meta }) => ({ id, source, kind, ref, title, text, author, date, visibility, url: url || null, meta: meta?.state ? { state: meta.state, assignee: meta.assignee } : {} }));
  const strip = ({ id, type, label, status, text, topic, choice, citations, basis, date, risk, item, itemRef, person, missing, leaving, conflictGroup, confirmed, answer, fix, done, supersededBy, memberRefs }) => ({ id, type, label, status, text, topic, choice, citations, basis, date, risk, item, itemRef, person, missing, leaving, conflictGroup, confirmed, answer, fix, done, supersededBy, memberRefs });
  const rv = {};
  for (const c of ho.list) rv[c.id] = reviews[c.id]?.text ? { status: "approved", text: reviews[c.id].text } : { status: "approved" };
  return {
    v: 1,
    project: { name: project.name, leaver: project.leaver, exitDate: project.exitDate },
    role: ho.role,
    version: { n: version.n, by: version.by, at: version.at, readiness: version.readiness ?? null },
    topics: Object.fromEntries(claims.filter((c) => c.topic).map((c) => [c.topic, null])),
    claims: claims.map(strip),
    evidence: ev,
    reviews: rv,
    sharedAt: new Date().toISOString(),
  };
}
