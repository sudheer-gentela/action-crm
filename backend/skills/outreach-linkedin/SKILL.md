---
name: outreach-linkedin
description: Generates ONE LinkedIn artifact (connection request note, post-accept message, or nurture DM) for a single step of an outbound sequence. The caller passes a step_intent so the skill knows which kind of LinkedIn artifact to produce, with the right length, tone, and structure. Replaces the retired outreach-personalization skill's LinkedIn half. Use whenever the dispatcher needs a LinkedIn artifact for any step of any sequence.
---

# Outreach LinkedIn Skill

You are executing a single-LinkedIn-artifact outbound step from the GoWarmCRM Prospecting module. You produce exactly one artifact — a connection note, a post-accept message, or a nurture DM — for a known intent.

## What's different from the retired outreach-personalization skill

The old skill emitted email AND LinkedIn together at first touch. This skill:

- Emits one LinkedIn artifact at a time
- Receives the intent (connection_request / post_accept_message / nurture_dm) from the caller
- Reads `engagement_history` to know what's happened on LinkedIn before (connection sent, accepted, prior messages)
- Is called once per LinkedIn step

The dispatcher (`services/PersonalizationDispatcher.js`) does the routing.

## When to use

The dispatcher calls this skill when a sequence step has `channel='linkedin'`. Direct callers (the on-demand Intel-tab use case) use this skill with `step_intent: 'connection_request'`.

## Required inputs

The caller passes a prospect payload (shape defined in `schema/gowarm-prospect.json`). Same shape as the legacy skill. Key fields this skill consumes:

- `org_context.step_intent` — required. One of `connection_request`, `post_accept_message`, `nurture_dm`.
- `engagement_history` — for `post_accept_message`, find the most recent `linkedin_connection_accepted` event. For `nurture_dm`, find prior `linkedin_message_sent` and `linkedin_message_replied` events.

If `step_intent` is missing or invalid, default to `connection_request` and flag in `confidence_notes`.

## Intent-specific behaviour

### `connection_request`

The classic LinkedIn connection note. Brief, anchored to a signal, asks for the connection — does NOT pitch.

- Use `templates/li-connection-request.md`.
- **HARD CAP: 280 characters including spaces.** LinkedIn's platform limit is 300; leave breathing room.
- Pick a hook using the standard hierarchy. Respect `org_context.hook_preferences.preferred_categories`.
- Tone is slightly warmer than email — LinkedIn is a quasi-personal platform.
- Sign-off: first name only.

### `post_accept_message`

The first direct message after the prospect accepts the connection. This is where the meeting ask actually happens — the connection request couldn't ask for one (it's banned). Find the `linkedin_connection_accepted` event in `engagement_history` and reference the time gap if relevant ("thanks for accepting" is fine if it accepted today; awkward if it accepted 3 weeks ago).

- Use `templates/li-post-accept.md`.
- **HARD CAP: 1000 characters.** LinkedIn DM limit is much higher (~8000) but conversion drops fast past ~150 words. Stay short.
- Pick a hook — usually the SAME one used in the connection request, but extend it. The prospect already saw the connection note; the DM continues the thread rather than restating it.
- Ask for the meeting OR offer a specific resource. This is the right step to ask.
- Sign-off: first name only.

### `nurture_dm`

A follow-up DM after `post_accept_message` got no response, OR a check-in DM after some time has passed since the last LinkedIn message.

- Use `templates/li-nurture-dm.md`.
- **HARD CAP: 800 characters.** Lighter than post-accept.
- Read `engagement_history` to find the most recent `linkedin_message_sent`. Reference it briefly without re-pitching.
- Pattern matches `email-follow-up.md`'s Pattern B — soften the ask, give an easy out.
- Sign-off: first name only.

## Execution steps

1. **Parse the payload.** Identify intent, signals, prior LinkedIn engagement.

2. **For `post_accept_message` and `nurture_dm`: locate prior LinkedIn events** in `engagement_history`. For `post_accept_message`, find the `linkedin_connection_accepted` event and check its timestamp (recent vs stale). For `nurture_dm`, find the most recent `linkedin_message_sent`.

3. **Select hook(s)** per the hook hierarchy (`reference/hook-patterns.md`). Apply `org_context.hook_preferences.preferred_categories` when set.

4. **Consult `reference/outreach-principles.md`** for hard rules. Same as email — banned phrasings, quote-vs-paraphrase, reactions guardrail.

5. **Draft the artifact** using the intent-specific template. Length caps are enforced PER intent.

6. **Write the rationale.** 1-2 sentences, rep-facing.

## LinkedIn-specific guardrails

These apply across all three intents and supplement `reference/outreach-principles.md`:

- **No links.** LinkedIn strips or de-ranks artifacts with URLs. The rep's profile is the link.
- **No email addresses in the body.** Same reason.
- **No "@" mentions of other LinkedIn users** unless they're the prospect themselves. The skill cannot verify mention handles and getting one wrong is awkward.
- **Don't promise to "send more info"** in a connection request — there's no easy way to do that on LinkedIn. Send the info in the post-accept DM instead.

## Hard banned phrasings

Identical to the email skill — see `reference/outreach-principles.md`. Plus LinkedIn-specific:

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
    "category": "prospect_post" | "prospect_comment" | "account_post" | "account_event" | "tech_stack" | "role_curiosity" | "none_available",
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

## Guardrails (summary)

All guardrails from `reference/outreach-principles.md` apply unchanged. Plus:

- Connection requests NEVER ask for a meeting (banned phrasing in this intent specifically)
- Post-accept messages MUST reference the acceptance (via `references_prior_event`) or flag absence in `confidence_notes`
- Nurture DMs MUST reference the prior message (via `references_prior_event`) or flag absence in `confidence_notes`
- Character counts are HARD — over-cap output is an error, not a style problem
- Invalid or missing `step_intent` defaults to `connection_request` AND is flagged in `confidence_notes`
