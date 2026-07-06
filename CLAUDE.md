# new_app_test — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About new_app_test

Sinyal Chart AI — a forex/crypto chart-analysis signal bot. The user
uploads a screenshot of a price chart; the server sends it to the
platform LLM proxy (Claude vision, forced tool-use structured output)
and renders a BUY/SELL/HOLD signal with confidence, technical
reasoning, and suggested stop-loss/take-profit zones. Analyses are
saved per user in the `analyses` table. UI copy is Bahasa Indonesia,
trading terms in English.

## App-specific conventions

- Signals are **analysis aids, not financial advice** — the amber
  disclaimer must stay always-visible; don't remove or soften it.
- The `analyses` table is marked `staging:private` (users' charts are
  owner-only content). Staging demo rows come from the read-only
  `?demo=1` injection on `GET /api/analyses`, never DB inserts.
- Images are stored as base64 data-URLs in `analyses.image_data`
  (client downscales to ≤1400px JPEG q0.85 before upload); history is
  pruned to the newest 50 rows per user on insert.
