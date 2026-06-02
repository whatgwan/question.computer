# Deep Thought Inversion

A machine that asks the wrong question once a day, then changes the question.
Lives at **[question.computer](https://question.computer)**.

An inversion of the usual setup: instead of grinding toward one answer, it
treats arriving at a tidy answer as the signal it's asking the wrong thing —
so when the answer stagnates, it rewrites the question instead. The bug
(stagnation) and the feature (reframing) are the same mechanism.

This repo is **documentation, not infrastructure**. The live site runs on a
single Cloudflare Worker. This repo exists so the loop is transparent: read it,
run the Python version, fork it.

## Layout

Clean separation — each file does one thing:

- `site/public/index.html` — the page, a plain static file served by
  Cloudflare's CDN.
- `site/worker.js` — *just the loop*: the daily cycle, `/data.json`, and the
  cron handler. No HTML inside it.
- `site/wrangler.toml` — wires them together (static assets binding, KV, cron).
- `loop.py` — the original Python reference. Same logic, easier to read and run
  locally. Not used in production.

The only thing **not** in this repo is the Anthropic API key. It lives in
Cloudflare's secret store and never touches any published file.

## How the loop works

1. Ask the current question, get a one-sentence answer (`deepThought`).
2. Check whether the answer stagnated — it collapsed to a tidy non-answer
   (e.g. "42"), or it barely changed from yesterday (Jaccard word overlap
   above a threshold) (`hasStagnated`).
3. If it stagnated, rewrite the question from a new angle (`reframe`).
4. Append the day's entry and carry the (possibly new) question forward.

State is one JSON blob in KV: the current question, the **full** history (never
truncated), and a few display fields (running cost, donations, donate link).

### The archive is durable

The history is the point, so it's preserved two ways:

- **KV** holds the live state (a single value; decades of daily entries fit well
  within the 25 MB limit).
- **Git backup** — after each daily cycle the Worker commits the entire state to
  `data/state.json` in this repo (set `GITHUB_TOKEN`; see deploy step 3b). It's a
  versioned, public, off-Cloudflare copy.
- **Restore** — if KV is ever empty or wiped, the Worker rehydrates from the Git
  backup before starting fresh, so a lost namespace doesn't erase the archive.

## Run the Python reference locally

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...
python loop.py            # appends one entry to data.json
python -m http.server     # open http://localhost:8000 to see the page
```

## Deploy the live site (Cloudflare)

Requires a Cloudflare account and `wrangler` (`npm i -g wrangler`).

```bash
cd site

# 0. Authenticate wrangler with your Cloudflare account (one time, opens browser)
wrangler login

# 1. Create the KV namespace, paste the returned id into wrangler.toml
wrangler kv namespace create STATE

# 2. Set the API key as a secret (never committed)
wrangler secret put ANTHROPIC_API_KEY

# 3. (Optional) token to allow manual test runs via /run?key=...
wrangler secret put RUN_TOKEN

# 3b. (Recommended) GitHub token so the daily cycle backs up the full archive.
#     Create a fine-grained PAT scoped to this repo with Contents: read+write,
#     then: wrangler secret put GITHUB_TOKEN
#     (Backup target is the GITHUB_* vars in wrangler.toml.)
wrangler secret put GITHUB_TOKEN

# 4. Deploy — uploads the Worker AND the public/ assets together
wrangler deploy
```

The page serves from `public/index.html` via the CDN; the Worker handles
`/data.json` and the daily cron. To test a cycle without waiting, visit
`https://your-worker-url/run?key=YOUR_RUN_TOKEN`.

### Custom domain (question.computer)

Cloudflare dashboard -> Workers & Pages -> your worker -> Settings ->
Domains & Routes -> Add custom domain -> `question.computer`. If the domain is
registered with / using Cloudflare nameservers, DNS is automatic; otherwise
point its nameservers at Cloudflare first.

## Getting an Anthropic API key

The Claude.ai Max/Pro subscription is **separate** from API access and can't be
used here. Get an API key from the Anthropic Console:

1. **console.anthropic.com** -> sign in (any account).
2. **Plans & Billing** -> add prepaid credit (~$10 lasts years at one
   short call/day).
3. **API Keys** -> Create Key -> copy the `sk-ant-...` value.

## Knobs

- Cron time: `crons` in `wrangler.toml` (UTC).
- Model: `MODEL` var. Defaults to the latest/most-capable model. Opus is
  overkill for one-sentence answers — `claude-haiku-4-5-20251001` costs ~5x
  less and is fine here.
- Stagnation sensitivity: `threshold` in `hasStagnated` (lower = reframes more readily).
- Seed question, daily cost, donate link: vars in `wrangler.toml`.
- Donations total: stored in KV state; update it as donations come in.

## On "forever"

This runs untended for years, not literally forever. Three things eventually
need a human: the API key / billing, the model string (deprecated someday),
and the platform's free tier. That's the cost of a machine that actually
thinks instead of replaying a script.

## Affiliation

An unaffiliated tribute. Not associated with or endorsed by the rights-holders
of any work it alludes to.
