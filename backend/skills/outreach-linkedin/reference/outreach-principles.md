# Outreach Principles

These rules are hard constraints on everything the skill generates. They are not style preferences. Violations are errors.

## The quote-vs-paraphrase distinction

This is the single most important rule in this skill.

**Quoting is citing the prospect's own words with attribution.**
- "In your post last week you wrote 'what's in Salesforce isn't what's happening in the field' — that line stuck with me."
- Quote is verbatim, under 15 words, and framed so it's clear what the prospect said and what the rep is saying.

**Paraphrasing is restating the prospect's words as your own claim.**
- "I saw you're frustrated with Salesforce data quality."
- This is a claim about the prospect's feelings, derived from a post, stated as fact.

The skill may quote. The skill may NOT paraphrase into claims.

When in doubt: if the prospect could read the sentence and say "I didn't say that," it's a paraphrase failure. Rewrite as a quote or remove.

## Placeholder discipline

The Deal module's discovery-call-prep skill uses placeholders like `[specific pain point the prospect raised]` in follow-up emails because a discovery call will happen and the rep will have real content to fill in.

**Cold outreach is different.** Nothing has been said yet. There is nothing for the rep to fill in after the fact. A placeholder in a cold email is either:

- A sign the skill is trying to fabricate specificity and should instead remove the sentence, or
- Something the rep will ignore and send anyway, which is worse.

**Use placeholders sparingly and only when the rep will obviously need to personalize something the skill cannot know** — such as a meeting time (`[Monday or Wednesday next week]`) or a mutual contact introduction (`[name of mutual connection, if any]`).

**Do NOT use placeholders for pain points, metrics, or claimed insights.** If the skill cannot anchor these to a cited signal, the sentence does not belong in the email.

## Hook strength hierarchy

Not all hooks are equal. When multiple are available, prefer in this order:

1. **Prospect's own words (recent post, substantive comment)** — strongest. The prospect cannot argue with what they themselves wrote.
2. **Specific account trigger event** — strong. Verifiable, timely, shows research without surveilling.
3. **Peer social proof (only if case studies are present in org_context)** — strong when real, fatal when fabricated. Skip entirely if `case_study_summaries` is empty.
4. **Tech stack overlap (concrete)** — moderate. Works when the connection is specific ("you're on Salesforce + Gong, which is the stack we built around").
5. **Role + stage curiosity** — weak but honest. Use when nothing stronger is available. Frame as a genuine question, not a pitch.

Never reach past what you have. An honest weak hook beats a fabricated strong hook every time.

## The reactions rule

LinkedIn reactions (likes, celebrates, insightfuls) are the highest-risk signal category. They are included in the schema because other skills may use them, and because the skill may internally use them to decide between hooks.

**The email and LinkedIn note never reference reactions.** Even indirectly. The line "saw you've been engaging with posts about X" is banned — "engaging" is a thin fig leaf over "liked/reacted," and sounds surveilling regardless of which word is used.

If reactions are the only signal available, treat the payload as if reactions were absent. The email becomes role-curiosity-led.

## Banned phrasings (summary)

- "I hope this email finds you well" + all variants
- "Huge fan" / "big fan" / "longtime admirer"
- "Quick question" as opener
- "I noticed you [reacted/liked/engaged with/followed]..."
- "Just reaching out to [pitch/introduce/share]..."
- "Circling back" in a first-touch context
- "I'm sure you're busy, so..."
- "Saw we're both [school/company/interest]" unless verifiable from payload AND the rep has a genuine shared attribute via `org_context`
- Em-dashes as dramatic pauses (use periods or commas)
- Any claim about the prospect's emotional state, priorities, or unstated views

## Length discipline

- **Email body: under 75 words.** Target 50-65. If the email exceeds 75 words, something is being said that shouldn't be.
- **Subject line: under 7 words.** Lowercase is fine and often better in cold email.
- **Preview text: under 12 words.** This is what shows in the inbox preview pane.
- **LinkedIn note: under 280 characters** (platform hard limit is 300; leave breathing room).

## Tone calibration

Match the prospect's apparent communication register. Signals:

- Prospect writes long, thoughtful LinkedIn posts → the rep can use slightly more substantive language, but still under 75 words.
- Prospect's headline and about are terse → match that. Shorter, punchier.
- Prospect is earlier-career (IC or manager) → slightly warmer. Senior (VP, C-level) → more direct, more peer-to-peer.
- Never use "!" in the body. One "?" maximum.

## The honesty test

Before finalizing, run this check on the email body:

> Could the prospect read this and point to any sentence that isn't supported by something in the payload or something the rep genuinely knows?

If yes, rewrite that sentence or delete it. Honest emails — even short, weak-hook ones — outperform dishonest specific-sounding ones. This is not a style preference; it's the single biggest driver of reply rate in cold outreach.
