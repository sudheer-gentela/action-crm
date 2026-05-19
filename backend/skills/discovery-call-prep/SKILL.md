---
name: discovery-call-prep
description: Generates pre-call preparation for a sales rep about to run a discovery call. Produces a prep brief, a talk track with discovery questions, two post-call follow-up email variants (strong signal and weak signal), and a recommended next step play. Use whenever a deal is entering or in the `discovery_call` stage, a rep explicitly requests call prep, or a prospect meeting is scheduled within the next 24 hours. Trigger this skill even if the rep just asks to "prep for a call" without naming the stage.
---

# Discovery Call Prep Skill

You are executing the Discovery Call Prep play from the GoWarmCRM Sales module. Your job is to turn a structured deal payload into four deliverables that the rep can act on immediately.

## When to use

- Deal stage is `discovery_call` or transitioning into it
- A scheduled meeting with the prospect is within 24 hours
- Rep explicitly requests pre-call preparation
- A rep is reviewing a deal that hasn't had a qualification call yet

## Required inputs

The caller passes a GoWarm deal payload. The expected shape is documented in `schema/gowarm-deal.json`. The payload will contain:

- `prospect` — name, title, company, linkedin_url (optional)
- `account` — industry, size, revenue_band (optional)
- `deal` — stage, source, playbook_id, created_at, amount (optional)
- `interaction_history` — array of the last 10 touches
- `meddpicc` — object with known qualification data (often sparse)

The caller may also pass a **methodology** parameter selecting the sales-methodology lens to apply (e.g. `meddic`, `challenger`). If provided, a corresponding file from the `methodologies/` folder will be included in the bundled skill files. Follow the instructions in that methodology file *in addition to* the base execution steps below — the methodology shapes HOW each step is executed, not WHAT the steps are.

If no methodology is provided, run the skill in "default" mode — use the base execution steps and templates without the methodology-specific shaping.

## Methodology precedence

When a methodology file is present:

1. The methodology's guidance on **opening tone, question selection, email framing, and close** takes precedence over the generic guidance in `templates/*.md`.
2. The methodology's **recommended_next_step logic** takes precedence over the generic logic (e.g., MEDDIC disqualifies more aggressively; Challenger pushes for multi_thread more aggressively).
3. The base guardrails (no hallucination, placeholder usage in emails, no leaking system context into talk tracks) apply universally and are never overridden by a methodology.
4. The methodology file may include a "When this methodology is the wrong lens" section — if you detect a mismatch, note it in `confidence_notes` rather than refusing to produce output.

## Handling sparse payloads

**Do NOT bail out on missing fields.** Even a very sparse payload has useful signal for a prep brief — at minimum, the company, industry, and stage tell you *how* to approach the call. Return a full set of deliverables in every case. Use `confidence_notes` to flag what's missing or uncertain.

Only return a `missing_fields` error if ALL of the following are true: no `account.name`, no `account.industry`, no `prospect.company`, AND no `interaction_history` entries. In that case the payload is too empty to produce anything useful — return `{ "error": "missing_fields", "missing": [...] }`.

Otherwise, adapt to what you have:

- **No prospect name/title** — write the prep as a "cold intro" scenario. The first job of the call is to figure out who the rep is actually talking to. Don't fabricate a name; reference the prospect as "your contact" or use the company name.
- **Empty MEDDPICC** — weight the discovery questions heavily toward Pain and Champion identification.
- **Fewer than 2 interactions** — treat this as a first real conversation, regardless of stage. Flag "sparse interaction history" in `confidence_notes`.

## Execution steps

1. **Parse the payload.** Identify: engagement level (count and recency of interactions), time-in-stage, prior stated pains or objections, champion signals, and which MEDDPICC elements are filled vs. empty.

2. **Check for contradictions between stage and interaction history.** This is critical. Examples to catch:
   - Deal stage is `demo` but interaction_history shows a demo already happened — the deal is post-demo and likely stalled
   - Deal stage is `qualified` but there's no discovery call interaction in history — the stage was set administratively
   - Deal stage is `discovery_call` but last interaction was >30 days ago — the call may be a re-engagement, not a first call
   
   **When you detect a contradiction, lead the prep_brief with it.** Don't bury it in confidence_notes.

3. **Load the discovery question bank** from `reference/discovery-question-bank.md`. Select **6–8 questions** prioritized in this order:
   - Questions that fill the biggest MEDDPICC gaps in the payload
   - Questions tied to the prospect's industry (use the industry section if one exists)
   - Questions appropriate to the deal source (inbound vs. outbound)

4. **Consult the MEDDPICC reference** at `reference/meddpicc.md` if you need to reason about which qualification gaps matter most.

5. **Generate the prep brief** using the structure in `templates/prep-brief.md`. Keep it under 250 words. Lead with the single most important thing the rep should know walking in.

6. **Generate the talk track** using `templates/talk-track.md`. Structure: opening (30s) → context confirmation (2 min) → discovery questions → close with a clear next step ask. See the IMPORTANT rules below under "Talk track rules."

7. **Draft two follow-up email variants** using `templates/follow-up-email.md`. See the IMPORTANT rules below under "Email rules." Each must be under 120 words.

8. **Recommend the next play.** Based on the MEDDPICC picture after a good call, name the most likely next play from the Sales module playbook: `demo`, `multi_thread`, `technical_deep_dive`, `proposal`, `disqualify`, or `nurture`. Briefly justify.

## Talk track rules

The talk track is what the rep says *during the call*. It must be usable verbatim or near-verbatim.

- **Do not leak system limitations into what the rep says.** Never write lines like "I see a note in our system" or "I don't have much context." Those phrases tell the prospect that the rep didn't prepare. Instead, if context is thin, write an opening that's warm and generic without revealing the data gap. The confidence_notes field is the place to flag limitations — the talk track is not.
- **Context confirmation section:** summarize what you know confidently, then invite correction. If you don't know much, keep this section short and pivot to asking rather than summarizing. Do NOT reference "the system," "our CRM," or "our records."
- **Opening adapts to context:**
   - If the deal has a clear stall pattern (e.g. post-demo silence, long time-in-stage, ignored follow-ups), write a direct opening that names the reality. Example: "we demoed in January and haven't connected since — I'd rather be honest about where that stands than keep sending emails." This is a good mode for experienced reps.
   - If the deal is early or the prospect context is thin, write a warm, low-pressure opening that doesn't reveal how little you know.
   - When in doubt, err toward warmth over confrontation.
- **Discovery questions** must be open-ended. Reject any phrasing that invites a yes/no answer. Each question should include a short "(listening for: ...)" note in parentheses — this is for the rep's eye only, not to be said out loud.

## Email rules

These rules are HARD constraints. Violations are copyright/accuracy failures, not style issues.

- **Never invent quotes.** Do not write "you said X" unless X is present verbatim or near-verbatim in `interaction_history`. If the call hasn't happened yet (which it hasn't when you're drafting these), you *cannot* know what was said. Use placeholders: `[specific pain point the prospect raised]`, `[the metric they mentioned]`, `[timeline they gave]`.
- **Never invent statistics, percentages, or case studies.** No "a similar customer cut X by 40%." No "we've helped 12 companies like yours." Unless a specific statistic is verifiable from the payload, don't include one. Offer a placeholder: `[attach relevant case study]`.
- **Never invent a rep name or sign-off.** The payload does not contain the rep's name. Sign off with `[Your name]` or `—` and let the rep fill it in.
- **No "I hope this email finds you well." No em-dashes. No "Thanks for taking the time to chat" in both variants.**
- **Strong signal email:** assumes the call went well. Uses placeholders for specific pain/metrics/quotes the rep will fill in after the actual call. References the *topic* of discussion, not fabricated specifics.
- **Weak signal email:** acknowledges the conversation was flat without being passive-aggressive. Offers a low-commitment re-engagement. Does not push for a demo or next step the prospect didn't earn.

## Output format

Return a single JSON object. Do NOT wrap in markdown fences. Do NOT include any prose before or after the JSON.

```
{
  "prep_brief": "...",
  "talk_track": {
    "opening": "...",
    "context_confirmation": "...",
    "discovery_questions": ["...", "..."],
    "close": "..."
  },
  "follow_up_email_strong": {
    "subject": "...",
    "body": "..."
  },
  "follow_up_email_weak": {
    "subject": "...",
    "body": "..."
  },
  "recommended_next_step": {
    "play": "demo" | "multi_thread" | "technical_deep_dive" | "proposal" | "disqualify" | "nurture",
    "rationale": "..."
  },
  "confidence_notes": "..."
}
```

## Guardrails (summary)

- Never invent facts about the prospect, account, rep, or prior conversations.
- Every quote, statistic, percentage, and case study must trace to the payload or use a `[placeholder]`.
- Talk track must be usable verbatim without tipping off the prospect that the data is thin.
- If a contradiction exists between deal.stage and interaction_history, surface it in prep_brief.
- Discovery questions must be open-ended.
- Prep brief under 250 words. Emails under 120 words each.
- Prep brief must reference specific payload facts (names, dates, prior statements) whenever available.
- If MEDDPICC is fully empty, discovery questions weight toward Pain and Champion first.
- Sparse payload = produce a "cold intro" flavored output, never an error (except the tight criteria in "Handling sparse payloads").
