/**
 * Deep Thought Inversion — the loop.
 *
 * The page is a static asset (public/index.html), served by Cloudflare's CDN.
 * This Worker only does the thinking:
 *   - GET /data.json   -> current state from KV
 *   - GET /run?key=... -> manual one-cycle trigger (needs RUN_TOKEN)
 *   - scheduled (cron)  -> one cycle per day
 * Anything else falls through to the static asset (the page).
 *
 * The only secret is the API key: `wrangler secret put ANTHROPIC_API_KEY`.
 * It is never in this file.
 */

const DEFAULTS = {
  // Latest / most capable model. There is no API identifier that floats across
  // major versions, so "latest" means the newest model we've pinned here. The
  // undated alias auto-updates to the newest snapshot WITHIN this version;
  // moving to a future Opus is a one-line change here (or the MODEL var).
  model: "claude-opus-4-8",
  seed: "What is the meaning of life, the universe, and everything?",
  dailyCost: 0.01,
  donateUrl: "https://ko-fi.com/YOUR_HANDLE",
  // Durable backup of the full archive. The daily cycle commits the whole
  // state here so the history survives even if the KV namespace is lost.
  githubRepo: "whatgwan/question.computer",
  githubBranch: "main",
  githubPath: "data/state.json",
};

async function loadState(env) {
  const raw = await env.STATE.get("data");
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  // KV is empty or corrupt — try the durable Git backup before starting fresh,
  // so a lost/wiped KV namespace doesn't erase the archive.
  const restored = await restoreFromGit(env);
  if (restored) return restored;
  return {
    current_question: env.SEED_QUESTION || DEFAULTS.seed,
    dailyCost: Number(env.DAILY_COST) || DEFAULTS.dailyCost,
    donations: 0,
    donateUrl: env.DONATE_URL || DEFAULTS.donateUrl,
    entries: [],
  };
}

const saveState = (env, data) => env.STATE.put("data", JSON.stringify(data));

const ghRepo = (env) => env.GITHUB_REPO || DEFAULTS.githubRepo;
const ghBranch = (env) => env.GITHUB_BRANCH || DEFAULTS.githubBranch;
const ghPath = (env) => env.GITHUB_PATH || DEFAULTS.githubPath;

// UTF-8-safe base64 for the GitHub Contents API.
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Read the last committed state from the public repo. Best-effort: returns
// null on any miss so callers can fall through to a fresh state.
async function restoreFromGit(env) {
  if (!ghRepo(env)) return null;
  const url = "https://raw.githubusercontent.com/" + ghRepo(env) + "/" +
    ghBranch(env) + "/" + ghPath(env);
  try {
    const res = await fetch(url, { cf: { cacheTtl: 0 } });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    return data && Array.isArray(data.entries) ? data : null;
  } catch {
    return null;
  }
}

// Commit the full state back to the repo. Requires a GITHUB_TOKEN secret with
// contents:write; skipped silently if it isn't set. Throws on API error so the
// caller can log it without aborting the (already-saved) cycle.
async function backupToGit(env, data) {
  if (!env.GITHUB_TOKEN || !ghRepo(env)) return;
  const api = "https://api.github.com/repos/" + ghRepo(env) + "/contents/" + ghPath(env);
  const headers = {
    "authorization": "Bearer " + env.GITHUB_TOKEN,
    "accept": "application/vnd.github+json",
    "user-agent": "question-computer-worker",
    "content-type": "application/json",
  };

  let sha;
  const head = await fetch(api + "?ref=" + encodeURIComponent(ghBranch(env)), { headers });
  if (head.ok) sha = (await head.json()).sha;

  const body = {
    message: "data: " + (data.entries.at(-1)?.date || "update") + " (" + data.entries.length + " entries)",
    content: toBase64(JSON.stringify(data, null, 2)),
    branch: ghBranch(env),
  };
  if (sha) body.sha = sha;

  const res = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("github " + res.status + ": " + (await res.text()));
}

async function askModel(env, prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.MODEL || DEFAULTS.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("anthropic " + res.status + ": " + (await res.text()));
  const json = await res.json();
  return (json.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}

function hasStagnated(answer, prev, threshold = 0.6) {
  const cleaned = answer.trim().replace(/\.+$/, "").toLowerCase();
  if (cleaned === "42" || ["there is none", "none", "nothing"].includes(cleaned)) return true;
  const wa = new Set(answer.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(prev.toLowerCase().split(/\s+/).filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / new Set([...wa, ...wb]).size > threshold;
}

const deepThought = (env, q) =>
  askModel(env, "Answer this in a single sentence. If it has no real answer, say so plainly rather than padding:\n\n" + q, 120);

const reframe = (env, q, stale) =>
  askModel(env,
    "The question '" + q + "' keeps producing the same stale, final-sounding answer: '" + stale +
    "'. Rewrite the question from a completely different angle — a different discipline, scale, or framing — " +
    "so it can't collapse the same way. Return ONLY the new question, nothing else.", 80);

async function runCycle(env) {
  const data = await loadState(env);
  const question = data.current_question;
  const entries = data.entries || [];
  const prev = entries.length ? entries[entries.length - 1].answer : "";

  const answer = await deepThought(env, question);
  let reframed = false, nextQuestion = question;
  if (hasStagnated(answer, prev)) {
    nextQuestion = await reframe(env, question, answer);
    reframed = true;
  }

  entries.push({ date: new Date().toISOString().slice(0, 10), question, answer, reframed });
  data.current_question = nextQuestion;
  data.entries = entries; // keep the full archive — never truncate the history
  await saveState(env, data);
  // Durable off-Cloudflare backup. Best-effort: the cycle already succeeded.
  try { await backupToGit(env, data); } catch (e) { console.log("git backup failed: " + e.message); }
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/data.json") {
      return new Response(JSON.stringify(await loadState(env)), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/run") {
      if (!env.RUN_TOKEN || url.searchParams.get("key") !== env.RUN_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      const data = await runCycle(env);
      return new Response(JSON.stringify(data.entries.at(-1), null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Everything else -> the static page asset.
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env));
  },
};
