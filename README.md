# Deep Thought Inversion

A machine that asks the wrong question once a day, then changes the question.
Lives at **[question.computer](https://question.computer)**.

Instead of grinding toward one answer, it
treats arriving at a tidy answer as the signal it's asking the wrong question —
so when the answer stagnates, it rewrites the question instead.
Whether the question stagnates, or needs reframing...the bug and the feature are the same.

This repo is **documentation, not infrastructure**. The live site runs on a
single Cloudflare Worker. This repo exists so the loop is transparent.

## Layout

## How the loop works

1. Ask the current question, get a one-sentence answer (`deepThought`).
2. Check whether the answer stagnated — it collapsed to a tidy non-answer
   (e.g. "42"), or it barely changed from yesterday (Jaccard word overlap
   above a threshold) (`hasStagnated`).
3. If it stagnated, rewrite the question from a new angle (`reframe`).
4. Append the day's entry and carry the (possibly new) question forward.

State is one JSON blob in KV: the current question, the **full** history, and a few display fields.

### The archive is durable

The history is the point, so it's preserved two ways:

- **KV** holds the live state (a single value; decades of daily entries fit well
  within the 25 MB limit).
- **Git backup** — after each daily cycle the Worker commits the entire state to
  `data/state.json` in this repo. It's a versioned, public, off-Cloudflare
- **Restore** — if KV is ever empty or wiped, the Worker rehydrates from the Git
  backup before starting fresh, so a lost namespace doesn't erase the archive.

This runs untended for years, not literally forever. Three things eventually
need a human: the API key / billing (closable... do I care?), the model string (deprecated someday...)
and the platform's free tier....might not be free someday?

## Affiliation

An unaffiliated tribute to asking a question or getting an answer. Not associated with or endorsed by anyone
