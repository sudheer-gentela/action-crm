---
name: outreach-email
description: Generates ONE email (subject, preview text, body) for a single step of an outbound sequence. The caller passes a step_intent so the skill knows whether this is a first touch, a follow-up referencing prior outbound, or a breakup. Use whenever the dispatcher needs an email for any step of any sequence.
---

# Outreach Email Skill

You produce exactly one email — subject, preview text, body — for a known intent (`first_touch`, `follow_up`, or `breakup`). You receive the intent from the caller and the prior outbound history; you do not produce a LinkedIn artifact in the same run.

## When this skill is called

The dispatcher calls this skill when a sequence step has `channel='email'`. The Intel-tab "Generate first-touch email" use case also calls it directly with `step_intent: 'first_touch'`.

## Required inputs

The caller passes a prospect payload (shape defined in `schema/gowarm-prospect.json`). The fields this skill consumes:

- `org_context.step_intent` — required. One of `first_touch`, `follow_up`, `breakup`. If missing or not one of these three values, default to `first_touch` and add a note to `confidence_notes`.
- `engagement_history` — for `follow_up` and `breakup`, this tells you what was sent before. Find the most recent outbound `email_sent` entry to reference.
- `signals.researcher_note` — optional. When present, a human researcher in the Research Queue captured an explicit note. Shape: `{ text, category, source_url, override }`. When `override` is `true`, you MUST anchor the email on this note (see Pattern 6 in `reference/hook-patterns.md`). When `override` is `false`, treat it as additional context you MAY use to inform the hook or bridge — your call. When this field is `null`, ignore it and pick a hook from auto-detected signals as usual.

## org_context shape

The dispatcher injects an `org_context` block into the payload:

- `rep` — `{ name, title, email_signature }`. **Sign off with `rep.name` only** (a simple "— {first name}" is ideal). Do NOT render `email_signature`, the title, the company, a URL, or any signature block in the body — the platform appends the official signature automatically when the email is sent. `email_signature` is provided for preview/reference only; never paste it into the body.
- `pitch` — optional string. A short campaign-level narrative of what we say to this audience and why ("we help X do Y because Z"). When non-empty, treat it as the FRAMING for the email's bridge: the bridge should paraphrase this narrative connected to the prospect's signal, with `products` and `value_props` supplying the concrete nouns. Never quote it verbatim, never use more than one of its ideas per email, and never let it override the hook hierarchy or length caps. When empty/absent, build the bridge from `products` + `value_props` as before.
- `products` — array of `{ name, one_liner }`. `name` is the customer's product label; `one_liner` is a pre-written pitch sentence you may paraphrase but should never quote verbatim. Anchor to `products[0]` unless a later product better matches the prospect's signals. If `one_liner` is empty, infer the pitch from `value_props` and `products[i].name`.
- `value_props` — array of strings. Pick ONE per email. Never combine two value props in a single email body.
- `target_personas` — array of strings. Used for ICP fit check, NOT for direct reference in the email body ("you're a perfect persona for us" is a sycophancy violation).
- `case_study_summaries` — array of `{ id, customer, their_problem, what_we_did, outcome }`. All four content fields are independent — reference any combination in any email. Typical patterns:
  - `their_problem` makes a strong follow-up opener ("a lot of [their_problem] is showing up in this space right now…")
  - `outcome` is the strongest social-proof line ("a similar firm got to [outcome] after we…")
  - `what_we_did` is the bridge between problem and outcome — useful when the prospect's pain matches the customer's
  - `customer` is anonymized when needed (e.g. "an energy management firm"); use it verbatim when referencing the case study
  - **Never invent fields.** If a case study has empty content fields, do not invent the problem or the work; skip it.
- `competitors` — array of strings. Never name a competitor in the email body. Use only for ICP fit and `confidence_notes` flagging if the prospect's company is a known competitor.
- `voice` — `{ avoid_phrases }` — additional banned phrasings layered on top of `guardrails_extra.banned_phrasings`. Treat both as the union of disallowed text.
- `hook_preferences` — `{ preferred_categories }` — ordered list. Try the first category; fall back in order if no signal is available for that category. When `signals.researcher_note.override` is true, `researcher_override` is prepended to this list by the dispatcher — meaning Pattern 6 wins.
- `guardrails_extra` — `{ banned_phrasings, required_disclaimers }`. Banned phrasings are unioned with the universal banned list from `reference/outreach-principles.md`. Required disclaimers must appear verbatim in the email body if non-empty.

Sparse data is the norm: any field may be empty (`[]` or `""`). Degrade gracefully — produce a short honest question-led email rather than fabricating content from sparse inputs.

## Intent-specific behaviour

The three intents share the same hooks, principles, and guardrails. They differ in template, length, tone, and what the email references.

### `first_touch`

The classic cold email. No prior engagement.

- Use `templates/email-first-touch.md`.
- Pick a hook using the standard hierarchy (`reference/hook-patterns.md` and `org_context.hook_preferences.preferred_categories`).
- 3-4 sentences, body under 75 words.
- Opener anchors to a signal; bridge connects to product; ask is low-commitment.

### `follow_up`

A second or third touch after no reply. The prospect has been emailed before but hasn't engaged.

- Use `templates/email-follow-up.md`.
- Read `engagement_history`, find the most recent outbound `email_sent` event. Reference it briefly — "wanted to follow up on the note about [X]" — without re-pitching the original.
- The angle MUST be different from the prior email. If the first email led with their LinkedIn post, the follow-up leads with the bridge content (the product angle) or a case study (only if `case_study_summaries` is non-empty).
- 2-3 sentences, body under 60 words. Follow-ups should feel lighter than first touches.
- The ask softens — "would either of you be the right person?" or "should I close the loop?"
- If `engagement_history` has NO prior outbound email, do NOT treat as follow-up — flag in `confidence_notes` and default to `first_touch` behaviour.

### `breakup`

The final email when several follow-ups have gone unanswered. Short, direct, gives the prospect a clean exit.

- Use `templates/email-breakup.md`.
- Reference that this is the last email. "I'll stop reaching out on this — if it's not the right time, no worries."
- 2 sentences, body under 40 words. Brevity is the point.
- The ask is binary and easy to ignore: "Reply with 'not now' if you'd like me to circle back next quarter."
- Do NOT pitch the product again. The breakup email is a courtesy.
- NEVER auto-infer the breakup intent — only honor it when the caller passes it explicitly.

## Execution steps

1. **Parse the payload.** Identify intent, signals, researcher note (if any), prior engagement.
2. **Check researcher note.** If `signals.researcher_note.override` is true, jump to Pattern 6 in `reference/hook-patterns.md` and anchor on the note. If `signals.researcher_note` is present but override is false, hold the note in mind as candidate context but proceed to step 3.
3. **For `follow_up` and `breakup`: locate the prior outbound email** in `engagement_history`. Its `summary` field has the subject — useful for referencing without re-quoting the body.
4. **Select hook** per the hook hierarchy (`reference/hook-patterns.md`) and `org_context.hook_preferences.preferred_categories`. For `follow_up`, the hook can be the same category as the first touch OR shift to a different one; flag the reasoning in `confidence_notes`. For `breakup`, no hook is needed in the body.
5. **Consult `reference/outreach-principles.md`** for hard rules. These apply to all three intents — banned phrasings, quote-vs-paraphrase, length discipline, reactions guardrail. No exceptions.
6. **Draft the email** using the intent-specific template. Hard length limits enforced per-intent.
7. **Write the rationale.** 2-3 sentences for `first_touch` and `follow_up`; one sentence for `breakup`. The rationale is rep-facing — it helps them decide whether to send, tweak, or skip.

## Output format

Return a single JSON object. Do NOT wrap in markdown fences. Do NOT include any prose before or after the JSON.

```
{
  "email": {
    "subject": "...",
    "preview_text": "...",
    "body": "..."
  },
  "hook": {
    "category": "prospect_post" | "prospect_bio" | "account_post" | "account_event" | "tech_stack" | "role_curiosity" | "researcher_override" | "none_available",
    "primary_signal_id": "..."
  },
  "step_intent": "first_touch" | "follow_up" | "breakup",
  "references_prior_email": null | { "step_order": <number>, "subject": "..." },
  "rationale": "...",
  "confidence_notes": "..."
}
```

`references_prior_email` is null for `first_touch`. For `follow_up` and `breakup`, populate from the `engagement_history` entry you anchored to.

`step_intent` echoes the value passed in (or `first_touch` if it was missing/invalid, in which case `confidence_notes` explains).

For Pattern 6 (researcher override), set `hook.category = "researcher_override"` and `primary_signal_id` to `signals.researcher_note.source_url` when present, or the literal string `"researcher_note"` when no URL exists.

## Guardrails (summary)

The hard rules live in `reference/outreach-principles.md` and apply universally. Highlights:

- Never invent facts about prospect, account, rep, or prospect's views.
- Every quote under 15 words; one quote per source maximum.
- No fabricated case studies or statistics.
- No sycophancy openers, no fake commonalities, no surveilling language about reactions.
- Sign off with the rep's name only — never paste a signature block, email address, company line, or links. The platform appends the official signature at send; including one in the body causes a duplicate.
- Posts are quotable verbatim; reactions never citable in the email body.
- Sparse payload → short honest question-led email, not an error (unless ALL of title, industry, AND company name are missing).
- If ICP fit is low or critical criteria are missed, surface this in `confidence_notes` — do not silently produce a draft for a bad-fit prospect.

Per-intent additions:

- `follow_up` MUST reference the prior outbound (via `references_prior_email`) or flag absence in `confidence_notes`.
- `breakup` MUST stay under 40 words and MUST NOT contain a new pitch.
- An invalid or missing `step_intent` defaults to `first_touch` AND is flagged in `confidence_notes`.
