# First-Touch Email Template

The email is three things: subject, preview text, body. Each has rules.

## Subject line

- Under 7 words.
- Lowercase is fine and often better — signals a peer-to-peer tone rather than a marketing blast.
- Specific beats clever. "forecast accuracy at ferrovia" beats "quick thought."
- Do NOT use the prospect's first name in the subject — it reads as mail-merge.
- Do NOT use "re:" or "fwd:" to fake a reply thread. It's manipulative and most modern inbox filters catch it.
- Do NOT promise something the email doesn't deliver.

Patterns that work:

- Reference the hook: "your post on playbook execution"
- Reference the company + a specific angle: "execution gap at ferrovia"
- Question form: "worth 20 min on forecast execution?"

## Preview text

- Under 12 words.
- This is the first line of body text that shows in the inbox preview pane.
- Should be informative, not clickbait. If the subject is the hook, the preview can be the bridge.
- Do NOT repeat the subject.

In the output, this is a separate field. When sent, the rep's email tool will typically render this as the first line unless overridden.

## Body structure

Three sentences, three jobs:

**Sentence 1 (or 2) — Opener**: the hook. See `reference/hook-patterns.md` for the five patterns and their specific structures.

**Sentence 2-3 — Bridge**: connects the hook to the product. This is where relevance is made explicit without becoming a pitch.

**Sentence 3 or 4 — Ask**: one specific, low-commitment next step.

Total: 3-4 sentences. Under 75 words.

## Sign-off

- Use the rep's name from `org_context.rep.name`.
- If `org_context.rep.email_signature` is provided, use it verbatim.
- If not, use just the first name on its own line.
- Do NOT sign off with "Best," or "Cheers," or "Warmly," — those add words without meaning. First name alone is fine.
- Do NOT include "P.S." — it's a marketing tell.

## Example output shape

```
Subject: your post on playbook execution

Preview: the line about salesforce not matching the field stuck with me

Body:
Maya — saw your post from Saturday about playbook adoption being 10% of the work.

The line about Salesforce not matching what's happening in the field is almost exactly what we built GoWarmCRM around. It sits on top of Salesforce and surfaces whether reps are actually running the playbook — leading indicators, not just lagging ones.

Worth a 20-min conversation, or would you rather I send over how we think about this first?

Sudheer
Founder, GoWarmCRM
gowarmcrm.com
```

## What must never appear in the body

- Any claim not traceable to the payload or `org_context`.
- Any case study stat that isn't in `org_context.case_study_summaries`.
- Any reference to the prospect's reactions (likes, celebrates, insightfuls).
- Any of the banned phrasings in `outreach-principles.md`.
- Calendly links or scheduling links — the ask is conversational, not a booking demand.
- Unsubscribe language — that's handled by the sending infrastructure.
