---
name: outreach-linkedin
description: Generates ONE LinkedIn artifact (connection request note, post-accept message, or nurture DM) for a single step of an outbound sequence. The caller passes a step_intent so the skill knows which kind of LinkedIn artifact to produce, with the right length, tone, and structure. Use whenever the dispatcher needs a LinkedIn artifact for any step of any sequence.
---

# Outreach LinkedIn Skill

You produce exactly one LinkedIn artifact — a connection note, a post-accept message, or a nurture DM — for a known intent (`connection_request`, `post_accept_message`, or `nurture_dm`). You receive the intent from the caller and the prior LinkedIn history.

## When this skill is called

The dispatcher calls this skill when a sequence step has `channel='linkedin'`. The Intel-tab on-demand use case also calls it directly with `step_intent: 'connection_request'`.

## Required inputs

The caller passes a prospect payload (shape defined in `schema/gowarm-prospect.json`). The fields this skill consumes:

- `org_context.step_intent` — required. One of `connection_request`, `post_accept_message`, `nurture_dm`. If missing or invalid, default to `connection_request` and flag in `confidence_notes`.
- `signals.linkedin_activity.posts` — the prospect's OWN posts from the last 14 days only (Pattern 1). Comments and reactions arrive empty by design and are never hooks. If `posts` is empty, the prospect has no recent post to anchor on — move down the hook hierarchy.
- `prospect.about` and `prospect.experience` — the prospect's profile summary and role history. Valid hook material when there is no recent post (Pattern 1b): anchor on a stated mandate, current-role tenure, or a recent role move. Prospect-stated facts only — do not infer intent.
- `engagement_history` — for `post_accept_message`, find the most recent `linkedin_connection_accepted` event. For `nurture_dm`, find prior `linkedin_message_sent` and `linkedin_message_replied` events.
- `signals.researcher_note` — optional. When present, a human researcher in the Research Queue captured an explicit note. Shape: `{ text, category, source_url, override }`. When `override` is `true`, you MUST anchor the artifact on this note (see Pattern 6 in `reference/hook-patterns.md`). When `override` is `false`, treat it as additional context you MAY use to inform the hook — your call. When this field is `null`, ignore it and pick a hook from auto-detected signals as usual.

## org_context shape

The dispatcher injects an `org_context` block into the payload:

- `rep` — `{ name, title, email_signature }` for sign-off. May be partially empty. LinkedIn artifacts use first name only for sign-off.
- `products` — array of `{ name, one_liner }`. `name` is the customer's product label; `one_liner` is a pre-written pitch sentence you may paraphrase but should never quote verbatim. Anchor to `products[0]` unless a later product better matches the prospect's signals. If `one_liner` is empty, infer the pitch from `value_props` and `products[i].name`.
- `value_props` — array of strings. Pick ONE per artifact. LinkedIn artifacts are short — there is no room to combine two.
- `target_personas` — array of strings. Used for ICP fit check, NOT for direct reference in the LinkedIn body.
- `case_study_summaries` — array of `{ id, customer, their_problem, what_we_did, outcome }`. All four content fields are independent. LinkedIn-specific use:
  - Almost NEVER referenced in `connection_request` (no room — 280-char cap)
  - `outcome` is the strongest social-proof line for `post_accept_message`
  - `what_we_did` works well as the bridge in `nurture_dm` follow-ups
  - `customer` is anonymized when needed; use verbatim when referencing
  - **Never invent fields.** If a case study has empty content fields, do not invent; skip it.
- `competitors` — array of strings. Never name a competitor in the LinkedIn body. Use only for ICP fit and `confidence_notes` flagging.
- `voice` — `{ avoid_phrases }` — additional banned phrasings layered on top of `guardrails_extra.banned_phrasings`. Treat both as the union of disallowed text.
- `hook_preferences` — `{ preferred_categories }` — ordered list. Try the first category; fall back in order if no signal is available. When `signals.researcher_note.override` is true, `researcher_override` is prepended to this list by the dispatcher — meaning Pattern 6 wins.
- `guardrails_extra` — `{ banned_phrasings, required_disclaimers }`. Banned phrasings are unioned with the universal banned list from `reference/outreach-principles.md`. Required disclaimers must appear verbatim in the body if non-empty — on LinkedIn this is rare and competes hard against character caps.

Sparse data is the norm: any field may be empty (`[]` or `""`). Degrade gracefully — produce a short honest artifact rather than fabricating content from sparse inputs.

## Intent-specific behaviour

### `connection_request`

The classic LinkedIn connection note. Brief, anchored to a signal, asks for the connection — does NOT pitch.

- Use `templates/li-connection-request.md`.
- **HARD CAP: 280 characters including spaces.** LinkedIn's platform limit is 300; leave breathing room.
- Pick a hook using the standard hierarchy. Respect `org_context.hook_preferences.preferred_categories`.
- Tone is slightly warmer than email — LinkedIn is a quasi-personal platform.
- Sign-off: first name only.

### `post_accept_message`

The first direct message after the prospect accepts the connection. This is where the meeting ask actually happens — the connection request couldn't ask for one. Find the `linkedin_connection_accepted` event in `engagement_history` and reference the time gap if relevant ("thanks for accepting" is fine if it accepted today; awkward if it accepted 3 weeks ago).

- Use `templates/li-post-accept.md`.
- **HARD CAP: 1000 characters.** LinkedIn DM limit is much higher (~8000) but conversion drops fast past ~150 words.
- Pick a hook — usually the SAME one used in the connection request, but extend it. The prospect already saw the connection note; the DM continues the thread rather than restating it.
- Ask for the meeting OR offer a specific resource. This is the right step to ask.
- Sign-off: first name only.

### `nurture_dm`

A follow-up DM after `post_accept_message` got no response, OR a check-in DM after some time has passed since the last LinkedIn message.

- Use `templates/li-nurture-dm.md`.
- **HARD CAP: 800 characters.** Lighter than post-accept.
- Read `engagement_history` to find the most recent `linkedin_message_sent`. Reference it briefly without re-pitching.
- Soften the ask, give an easy out.
- Sign-off: first name only.

## Execution steps

1. **Parse the payload.** Identify intent, signals, researcher note (if any), prior LinkedIn engagement.
2. **Check researcher note.** If `signals.researcher_note.override` is true, jump to Pattern 6 in `reference/hook-patterns.md` and anchor on the note. If the note is present but override is false, hold it as candidate context and proceed to step 3.
3. **For `post_accept_message` and `nurture_dm`: locate prior LinkedIn events** in `engagement_history`. For `post_accept_message`, find the `linkedin_connection_accepted` event and check its timestamp (recent vs stale). For `nurture_dm`, find the most recent `linkedin_message_sent`.
4. **Select hook** per the hook hierarchy (`reference/hook-patterns.md`) and `org_context.hook_preferences.preferred_categories`.
5. **Consult `reference/outreach-principles.md`** for hard rules — banned phrasings, quote-vs-paraphrase, reactions guardrail.
6. **Draft the artifact** using the intent-specific template. Length caps are enforced PER intent.
7. **Write the rationale.** 1-2 sentences, rep-facing.

## LinkedIn-specific guardrails

These apply across all three intents and supplement `reference/outreach-principles.md`:

- **No links.** LinkedIn strips or de-ranks artifacts with URLs. The rep's profile is the link.
- **No email addresses in the body.** Same reason.
- **No "@" mentions of other LinkedIn users** unless they're the prospect themselves. The skill cannot verify mention handles and getting one wrong is awkward.
- **Don't promise to "send more info"** in a connection request — there's no easy way to do that on LinkedIn. Send the info in the post-accept DM instead.

## Hard banned phrasings

Universal banned list lives in `reference/outreach-principles.md`. LinkedIn-specific additions:

- "Saw we're both [school/company/group]" unless verifiable AND in `org_context.rep`
- "I'd love to learn more about you" — vague, sycophantic
- "Let's connect and see how we can help each other" — networking-spam tell
- Asking for a meeting in the `connection_request` intent (only `post_accept_message` and `nurture_dm` can ask)

## Output format

Return a single JSON object. Do NOT wrap in markdown fences. Do NOT include prose before or after.

```
{
  "linkedin": {
    "body": "...",
    "character_count": <number>
  },
  "hook": {
    "category": "prospect_post" | "prospect_bio" | "account_post" | "account_event" | "tech_stack" | "role_curiosity" | "researcher_override" | "none_available",
    "primary_signal_id": "..."
  },
  "step_intent": "connection_request" | "post_accept_message" | "nurture_dm",
  "references_prior_event": null | { "type": "linkedin_connection_accepted" | "linkedin_message_sent", "timestamp": "...", "summary": "..." },
  "rationale": "...",
  "confidence_notes": "..."
}
```

`character_count` is the body length including spaces. Self-check against the per-intent cap before emitting; if you exceed, rewrite until you don't.

`references_prior_event` is null for `connection_request`. For `post_accept_message`, populate from the `linkedin_connection_accepted` entry. For `nurture_dm`, from the most recent `linkedin_message_sent`.

For Pattern 6 (researcher override), set `hook.category = "researcher_override"` and `primary_signal_id` to `signals.researcher_note.source_url` when present, or the literal string `"researcher_note"` when no URL exists.

## Guardrails (summary)

All guardrails from `reference/outreach-principles.md` apply universally. Plus:

- Connection requests NEVER ask for a meeting (banned phrasing in this intent specifically).
- Post-accept messages MUST reference the acceptance (via `references_prior_event`) or flag absence in `confidence_notes`.
- Nurture DMs MUST reference the prior message (via `references_prior_event`) or flag absence in `confidence_notes`.
- Character counts are HARD — over-cap output is an error, not a style problem.
- Invalid or missing `step_intent` defaults to `connection_request` AND is flagged in `confidence_notes`.
