/**
 * Deep Thought Inversion — the loop.
 *
 * A static page (public/index.html) is served by Cloudflare's CDN. This Worker
 * only does the thinking:
 *   GET /data.json    -> current state (+ display config) as JSON
 *   cron (daily)      -> run one cycle
 *   anything else     -> the static page
 *
 * The only secret that must exist is ANTHROPIC_API_KEY — it lives in
 * Cloudflare's secret store, never in this file. Everything tunable (model,
 * seed question, funding figures, backup target) lives in wrangler.toml [vars];
 * this file just reads them, so there's one source of truth, not two.
 */


/* ─────────────────────────────── The loop ───────────────────────────────
 * One cycle = one day:
 *   1. answer the current question
 *   2. if that answer has stagnated, reframe the question for next time
 *   3. record the day and carry the (maybe new) question forward
 */
async function runCycle(env) {
  const { current_question: question, entries = [] } = await loadState(env);
  const prev = entries.length ? entries[entries.length - 1].answer : "";

  const answer = await deepThought(env, question);
  const reframed = hasStagnated(answer, prev);
  const nextQuestion = reframed ? await reframe(env, question, answer) : question;

  entries.push({ date: today(), question, answer, reframed });

  // Persist data only — question + the full archive (never config, never truncated).
  const next = { current_question: nextQuestion, entries };
  await saveState(env, next);
  try { await backupToGit(env, next); } catch (e) { console.log("git backup failed: " + e.message); }
  return next;
}

// Ask the question — one honest sentence, no padding.
const deepThought = (env, q) =>
  askModel(env, "Answer in a single sentence:\n\n" + q, 120);

// The inversion: a stale answer means the question is wrong, so rewrite it.
const reframe = (env, q, stale) =>
  askModel(env,
    "The question '" + q + "' keeps producing the same stale, final-sounding answer: '" + stale +
    "'. Rewrite the question from a completely different angle — a different discipline, scale, or framing — " +
    "so it can't collapse the same way. Return ONLY the new question, nothing else.", 80);

// Filler words that say nothing about an answer's substance — ignored when comparing.
const STOP = new Set(
  ("a an the and or but of to in on at for with as is are was were be been being it its this " +
   "that these those there here than then so such not no nor only just very more most can could " +
   "may might will would should about into over under from by").split(" "));

// Reduce an answer to its set of content words: lowercase, drop punctuation and stopwords.
const contentWords = (s) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w)));

// Stagnated = it returned the joke / a punt (in any wording), or it substantially
// recycles the previous answer's content words. Lexical only — meaning-blind, so a
// genuinely fresh answer rides; the question only reframes once answers start circling.
function hasStagnated(answer, prev, threshold = 0.35) {
  const flat = answer.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (/\b42\b/.test(flat) || ["none", "nothing"].includes(flat) ||
      flat.includes("there is none") || flat.includes("there is no answer")) return true;
  const wa = contentWords(answer);
  const wb = contentWords(prev);
  if (!wa.size || !wb.size) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / new Set([...wa, ...wb]).size > threshold; // Jaccard on content words
}

const today = () => new Date().toISOString().slice(0, 10);


/* ─────────────────────────────── Model ─────────────────────────────── */
async function askModel(env, prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: env.MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error("anthropic " + res.status + ": " + (await res.text()));
  const json = await res.json();
  return (json.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}


/* ──────────────────── State: KV is live, Git is durable ────────────────────
 * KV holds the live state. Each cycle also commits it to the repo; if KV is
 * ever empty or lost, we restore from that commit before starting fresh.
 */
async function loadState(env) {
  const raw = await env.STATE.get("data");
  if (raw) {
    try { return JSON.parse(raw); } catch { /* corrupt — fall through */ }
  }
  return (await restoreFromGit(env)) || { current_question: env.SEED_QUESTION, entries: [] };
}

const saveState = (env, data) => env.STATE.put("data", JSON.stringify(data));

const githubTarget = (env) => ({
  repo: env.GITHUB_REPO,
  branch: env.GITHUB_BRANCH,
  path: env.GITHUB_PATH,
});

// Read the last committed state from the public repo. Best-effort -> null on any miss.
async function restoreFromGit(env) {
  const { repo, branch, path } = githubTarget(env);
  if (!repo) return null;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, { cf: { cacheTtl: 0 } });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    return data && Array.isArray(data.entries) ? data : null;
  } catch {
    return null;
  }
}

// Commit the state to the repo. Needs a GITHUB_TOKEN secret (contents:write);
// no-ops if it's unset. Throws on API error so runCycle can log without aborting.
async function backupToGit(env, data) {
  const { repo, branch, path } = githubTarget(env);
  if (!env.GITHUB_TOKEN || !repo) return;
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = {
    "authorization": "Bearer " + env.GITHUB_TOKEN,
    "accept": "application/vnd.github+json",
    "user-agent": "question-computer-worker",
    "content-type": "application/json",
  };

  // Need the current file's sha to update it (omit to create).
  let sha;
  const head = await fetch(api + "?ref=" + encodeURIComponent(branch), { headers });
  if (head.ok) sha = (await head.json()).sha;

  const body = {
    message: "data: " + (data.entries.at(-1)?.date || "update") + " (" + data.entries.length + " entries)",
    content: toBase64(JSON.stringify(data, null, 2)),
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("github " + res.status + ": " + (await res.text()));
}

// UTF-8-safe base64 for the GitHub Contents API.
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}


/* ──────────── Display config: env -> /data.json, never persisted ────────────
 * The page reads these to render the funding box. Keeping them in env vars
 * means you edit them in wrangler.toml + redeploy, and the stored archive
 * stays pure data.
 */
const displayConfig = (env) => ({
  dailyCost: Number(env.DAILY_COST),
  balance: Number(env.BALANCE),
  balanceSince: env.BALANCE_SINCE,
});


/* ─────────────────────────────── HTTP + cron ─────────────────────────────── */
const json = (obj, headers = {}, indent) =>
  new Response(JSON.stringify(obj, null, indent), {
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/data.json") {
      const state = await loadState(env);
      return json({ ...state, ...displayConfig(env) }, { "cache-control": "no-store" });
    }

    return env.ASSETS.fetch(request); // the static page
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env));
  },
};
