#!/usr/bin/env python3
"""
Deep Thought Inversion — Python reference for the loop.

Same logic as site/worker.js, easier to read and run locally. NOT used in
production (the live site runs on the Cloudflare Worker). One run appends one
entry to data.json next to this file.

    pip install anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python loop.py
    python -m http.server   # open http://localhost:8000 to see the page
"""

import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from anthropic import Anthropic

# Date runs by Sydney's calendar day (matches the 9am-AEST cron), not UTC.
SYDNEY = ZoneInfo("Australia/Sydney")
today = lambda: datetime.now(SYDNEY).date().isoformat()

# Latest / most capable model (undated alias = newest snapshot of this version).
MODEL = os.environ.get("MODEL", "claude-opus-4-8")
SEED = "What is the meaning of life, the universe, and everything?"
DATA = Path(__file__).with_name("data.json")

client = Anthropic()


def ask(prompt: str, max_tokens: int) -> str:
    msg = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in msg.content if b.type == "text").strip()


def deep_thought(q: str) -> str:
    return ask("Answer in a single sentence:\n\n" + q, 120)


def reframe(q: str, stale: str) -> str:
    return ask(
        f"The question '{q}' keeps producing the same stale, final-sounding "
        f"answer: '{stale}'. Rewrite the question from a completely different "
        "angle — a different discipline, scale, or framing — so it can't "
        "collapse the same way. Return ONLY the new question, nothing else.",
        80,
    )


# Filler words that say nothing about an answer's substance — ignored when comparing.
STOP = set(
    ("a an the and or but of to in on at for with as is are was were be been being it its this "
     "that these those there here than then so such not no nor only just very more most can could "
     "may might will would should about into over under from by").split())


def content_words(s: str) -> set:
    """Reduce an answer to its content words: lowercase, drop punctuation and stopwords."""
    toks = re.sub(r"[^a-z0-9\s]", " ", s.lower()).split()
    return {w for w in toks if w and w not in STOP}


def has_stagnated(answer: str, prev: str, threshold: float = 0.35) -> bool:
    # Stagnated = it returned the joke / a punt (in any wording), or it substantially
    # recycles the previous answer's content words. Lexical only — meaning-blind, so a
    # genuinely fresh answer rides; the question only reframes once answers start circling.
    flat = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", answer.lower())).strip()
    if (re.search(r"\b42\b", flat) or flat in ("none", "nothing")
            or "there is none" in flat or "there is no answer" in flat):
        return True
    wa = content_words(answer)
    wb = content_words(prev)
    if not wa or not wb:
        return False
    return len(wa & wb) / len(wa | wb) > threshold


def load_state() -> dict:
    if DATA.exists():
        try:
            return json.loads(DATA.read_text())
        except json.JSONDecodeError:
            pass
    return {
        "current_question": SEED,
        "dailyCost": 0.01,
        "balance": 5,  # USD of prepaid API credit — the runway
        "balanceSince": date.today().isoformat(),
        "entries": [],
    }


def run_cycle() -> dict:
    data = load_state()
    question = data["current_question"]
    entries = data.get("entries", [])
    prev = entries[-1]["answer"] if entries else ""

    answer = deep_thought(question)
    reframed = False
    next_question = question
    if has_stagnated(answer, prev):
        next_question = reframe(question, answer)
        reframed = True

    entries.append({
        "date": today(),
        "question": question,
        "answer": answer,
        "reframed": reframed,
    })
    data["current_question"] = next_question
    data["entries"] = entries  # keep the full archive — never truncate
    DATA.write_text(json.dumps(data, indent=2))
    return data


if __name__ == "__main__":
    state = run_cycle()
    print(json.dumps(state["entries"][-1], indent=2))
