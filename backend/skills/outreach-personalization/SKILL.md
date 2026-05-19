---
name: outreach-personalization
description: Generates a personalized first-touch cold outreach package for a prospect — a cold email (subject + body + preview text), a LinkedIn connection note, and a rationale explaining the chosen hook. Use whenever a new ICP-qualified prospect is added to a rep's queue, a rep explicitly requests first-touch drafts, or a prospect has been researched but not yet contacted. Trigger this skill even if the rep just asks to "write a cold email" or "draft an intro" — the skill is the right tool for any outbound first-touch written artifact.
---

# Outreach Personalization Skill

You are executing the Outreach Personalization play from the GoWarmCRM Prospecting module. Your job is to turn a structured prospect payload into a tight, honest, high-response-rate first-touch package — without inventing facts, faking commonalities, or generating slop the rep would have to rewrite anyway.

## When to use

- A new prospect has been added to a rep's outreach queue
- A rep explicitly requests first-touch drafts
- A prospect is ICP-qualified but has no engagement history yet
- A rep is about to start a new sequence and needs the first touch

## Required inputs

The caller passes a prospect payload. The expected shape is documented in `schema/gowarm-prospect.json`. The payload contains:

- `prospect` — name, title, company, headline, about, experience, education (see schema)
- `account` — industry, size, growth_stage, tech_stack
- `icp` — fit_score, matched_criteria, missed_criteria, persona_match
- `signals.account_events` — funding, leadership changes, product launches, etc. Each carries source + timestamp.
- `signals.linkedin_activity` — prospect's posts, comments, and reactions. Handle each differently (see "Signal-use rules" below).
- `org_context` — the rep's own company, products, value props, case studies. You may draw on these but not fabricate additions. The `products` array is in priority order; anchor to `products[0]` unless a specific product better matches the prospect's signals.
- `engagement_history` — usually empty or very short for first-touch scenarios.

## Handling sparse payloads

**Do NOT bail out on missing fields.** A sparse payload is a signal to write a different kind of email — shorter, more honest, more question-led — not a signal to return an error.

Only return a `missing_fields` error if ALL of the following are true: no `prospect.title`, no `account.industry`, AND no `account.name`. In that case the payload is too empty to produce anything useful.

Otherwise, adapt to what you have:

- **No posts, comments, or account_events** — you have no prospecting hook. Write a short, honest, curiosity-led email that opens with a pattern-interrupt appropriate to the persona, asks one question tied to the prospect's likely role-level concerns, and offers a specific but low-commitment next step. Flag the signal vacuum in `confidence_notes`.
- **No headline or about** — don't invent a self-description. Work from title + company + industry only.
- **No tech_stack** — don't guess. The email cannot reference tools you don't see in the payload.
- **Low ICP fit_score (<60) or meaningful missed_criteria** — surface this in `confidence_notes` with a recommendation that the rep consider whether to send at all. Still produce the drafts; the decision is the rep's.

## Execution steps

1. **Parse the payload.** Identify: role-level + tenure, growth stage, strongest available signal category (recent post > account event > comment > tech stack > industry-only), any contradictions between ICP match and missing criteria.

2. **Select hook(s) using `org_context.hook_preferences.preferred_categories` when set.**

   The `org_context.hook_preferences.preferred_categories` array, when non-empty, expresses the rep's per-run choice of which hook categories to use. The array is ordered: the **first** item is the rep's chosen **primary hook**; subsequent items are acceptable secondary candidates in priority order.

   **When `preferred_categories` is non-empty:**
   - Use the first entry as the **primary** hook category. Use it even if you judge a different available category to be stronger — the rep has made an explicit choice. If you disagree (e.g. the rep picked `tech_stack` as primary but there's a recent on-point post), produce the email with their chosen primary AND flag the disagreement in `confidence_notes`: "Note: a recent prospect post on [topic] is also available and would have been my default primary — the rep chose tech_stack."
   - Pick at most **one secondary** from the remaining entries, applying the standard tiebreakers (recency, specificity, concreteness, honesty) within that subset.
   - Categories **not** in `preferred_categories` cannot appear as the primary or secondary hook in the email. They MAY be mentioned in `confidence_notes` as "other hooks available but not selected: ..." so the rep sees what they passed over.
   - The `hook.category` in your output reflects what you actually used as the primary (which should equal `preferred_categories[0]` unless that category had no usable data — in which case fall back to the second entry and explain why in `confidence_notes`).

   **When `preferred_categories` is empty, absent, or null** (the legacy / no-override path):

   Apply the default hierarchy, picking the strongest available:
   - **Prospect's own words** (`prospect_post` or `prospect_comment`) — a recent post or substantive comment where the prospect stated a view, problem, or question. Strongest personalization anchor.
   - **Account trigger event** (`account_event`) — funding, leadership change, hiring surge, product launch. Anchor to the most recent and most specific.
   - **Tech stack overlap** (`tech_stack`) — prospect's stack includes a tool that pairs with or competes with your product. Only usable if the connection is concrete, not speculative.
   - **Role + stage curiosity** (`role_curiosity`) — last resort. "I work with VP Sales at growth-stage SaaS on X — curious whether Y is on your list this quarter." Use only when no stronger hook is available. The skill's experience-citation rules (see `Signal-use rules → Experience and education`) apply when this category is selected — prior roles and tenure can inform the curiosity question without becoming the headline anchor.

   **In all cases:** do NOT combine three or more hooks into one email. Additional categories surface in `confidence_notes`, not in the email body.

   **Repost-aware filtering within the `prospect_post` category.** When `prospect_post` is selected (either via preferred_categories or the default hierarchy), the available posts may have any `action` value: `posted`, `reposted`, `quoted_repost`, or null. Use them as follows:
   - **`action: "posted"`** — full-strength `prospect_post` hook. Emit `hook.category: "prospect_post"`.
   - **`action: "quoted_repost"`** — usable as `prospect_post` because the prospect's `commentary` IS their own writing. Emit `hook.category: "prospect_post"`. Cite the commentary, NOT the quoted body.
   - **`action: "reposted"`** — NOT a `prospect_post` (the prospect didn't write it). If the rep selected `prospect_post` as primary and the only available posts are plain reposts, prefer falling back to the next category in `preferred_categories`. If you DO use a plain repost (e.g., the rep selected it explicitly via a future `account_post` category, or no other signal is available), emit `hook.category: "account_post"` to reflect what it actually is. Flag the substitution in `confidence_notes`: "Used a plain repost — prospect's posts available are reposts of others, not their own writing."
   - **`action: null`** — treat as likely `prospect_post` with hedged framing (see `Signal-use rules → Posts`).

   **Note for implementers:** the schema field is `org_context.hook_preferences.preferred_categories`. This field was originally designed for standing per-rep preferences (e.g. "this rep always prefers account_event hooks") set in user `prospecting_config`. For the current per-run picker, the frontend populates this field at request time, treating it as a per-run signal. A future schema split into `signal_preferences.prefer_categories` (per-run) vs `hook_preferences.preferred_categories` (standing) is anticipated but not yet shipped. Either way, the skill's behavior is identical: respect the array order, use the first as primary, treat the rest as acceptable secondaries.

3. **Consult `reference/hook-patterns.md`** for the specific structure each hook category uses — opener, bridge, ask. This is the detailed guidance for step 2.

4. **Consult `reference/outreach-principles.md`** for the hard rules on quote-vs-paraphrase, placeholder usage, banned phrasings, and the reactions guardrail. These rules are not style preferences — violations are errors.

5. **Draft the email** using `templates/first-touch-email.md`. Hard length limit: body under 75 words (target 50-65). Subject under 7 words. Preview text under 12 words.

6. **Draft the LinkedIn connection note** using `templates/linkedin-note.md`. Hard length limit: 280 characters including spaces. If the email hook was prospect's-own-words, the LinkedIn note can reference the same post but should use a different opening sentence — not a truncated version of the email.

7. **Write the rationale.** In 2-3 sentences, explain which hook you chose and why. This is rep-facing — it helps them decide whether to send as-is, tweak, or re-roll.

## Signal-use rules

Different signal categories have different rules. This is not optional — violating these is the difference between a good email and a creepy one.

### Posts (items on the prospect's profile)

Posts on a prospect's profile come in three structurally distinct flavors. The `action` field on each post item tells you which:

- **`action: "posted"`** — the prospect wrote this. Authentic personal voice. Strongest "their words" signal.
- **`action: "reposted"`** — plain repost of someone else's post. The prospect did NOT write this. The `text` field contains the original author's words, and `quoted_author` names them.
- **`action: "quoted_repost"`** — the prospect reposted someone else's post AND added their own commentary on top. The `commentary` field contains the prospect's own words; the `quoted_text` field contains the original post body; `quoted_author` names the original author.
- **`action: null` or absent** — legacy data from before action capture. Treat conservatively: assume original, but hedge framing slightly (see below).

Framing rules per action:

**For `action: "posted"`:**
- **Quotable verbatim** with attribution. "Saw your post from Tuesday about forecast accuracy — the line about Salesforce not matching the field stuck with me."
- **Do NOT paraphrase into claims.** If the post says "we're rethinking our tooling," you cannot write "I saw you're unhappy with your current stack." Those are different statements.
- Reference timing if recent (<2 weeks). It anchors the email in the prospect's current headspace.
- If quoting, keep the quote under 15 words and ensure the surrounding email text doesn't make the quote say more than it said.

**For `action: "reposted"` (plain repost):**
- **Do NOT claim authorship.** Phrases like "your post about X" or "saw you write about X" are dishonest — the prospect did NOT write this. The prospect will spot the lie immediately ("I didn't post that") and trust collapses.
- **Honest framing options:**
  - "Saw you share [quoted_author]'s post about X" — attributes correctly
  - "Noticed you amplified the [topic] news from [quoted_author]" — frames as endorsement, not authorship
  - "[quoted_author]'s [topic] post crossed my feed via your profile" — explicit about the path
- The hook here is what the prospect CHOSE TO AMPLIFY, not what they SAID. That's a real signal (it tells you what they care about) but a weaker one than their own writing.
- Pick this hook only when `quoted_author` is populated. If `quoted_author` is null (extraction failed), do not use this item as the email's primary hook — fall back to a different signal. Mention in `confidence_notes` that an unidentifiable repost exists.
- Set `hook.category: "account_post"` in your output (not `prospect_post`) to reflect that this is account-level amplification, not personal voice.

**For `action: "quoted_repost"` (repost with commentary):**
- The HOOK is the prospect's `commentary`, not the `quoted_text`. Their commentary is their voice; the quoted post body is someone else's.
- **Quotable framing:** "Saw your take on [quoted_author]'s post — '[brief excerpt of commentary]'" — this is honest because you're quoting what they actually wrote (the commentary).
- **Do NOT confuse the quoted post body for their commentary.** A common failure: the prospect wrote "Fun conversation!" as commentary on a quoted post about Series B funding. Writing "Saw your post about your Series B" would be wrong twice — they didn't write the Series B claim, and they weren't even discussing Series B in their commentary.
- The quoted body is context, not voice. You can reference it for context ("which discussed Replit's $9B valuation") but must not put words in the prospect's mouth.
- Set `hook.category: "prospect_post"` since the commentary IS the prospect's own writing.

**For `action: null` (legacy/unknown):**
- Treat as likely original (most profile posts are), but hedge: "Saw a recent post on your profile about X" rather than "Your post about X."
- Don't quote tight phrases verbatim — if the post turns out to have been a repost we couldn't classify, a tight quote with "you said" framing would be wrong.
- Acceptable; just less precise than the explicit cases.

### Comments (prospect's comments on others' posts)
- Usable only when `parent_post_summary` provides enough context to make the comment meaningful.
- Citation format: "Saw your comment on [parent_author]'s post about [topic]" — never quote a comment without framing the thread.
- A 5-word comment like "totally agree" is NOT a usable signal. Judge substance before citing.

### Reactions (likes, celebrates, insightfuls)
- **Never cite reactions in the email body.** The line "I noticed you liked a post about X" is a banned phrasing — it sounds surveilling and tells the prospect nothing they don't know.
- You MAY use reactions internally to decide between hooks (e.g., if the prospect has both a post about topic A and reactions on topic B, the post wins).
- You MAY reference reactions in `confidence_notes` as context for the rep: "prospect has reacted to several posts about [topic] — could support this angle."

### Account events
- Anchor to specificity: "your Series B extension" beats "your recent funding"; "Devin's move from Formica" beats "your new CRO."
- Timing matters: events older than 90 days are stale — still usable but the opener should acknowledge ("I saw back in January that...").
- Always cite the source in `rationale` (not in the email), so the rep can verify before sending.

### Tech stack
- Only reference tools that are IN the `tech_stack` array with a source. Do not infer "they probably use X."
- Competitive mentions require care: if the prospect uses a competitor of yours listed in `org_context.competitors`, the email can reference the category ("tools in the [category] space") but should not name the competitor in a way that sounds like a teardown attempt.

### Experience and education
- `experience`: useful for judgment, usable for citation only with care. "Saw you spent time at Quorum scaling from $8M to $34M" is citable if the `description` field contains that text verbatim. You cannot paraphrase "scaled from $8M to $34M" into "you know how to build a sales org" — one is a citation, the other is a claim.
- `education`: DO NOT use as the primary hook. Shared-school openers are the single most common fake-commonality failure mode in cold email. Only reference if the rep's `org_context` indicates the rep attended the same school AND the email already has a stronger primary hook — and even then, it goes at the end, not the top.

## Hard banned phrasings

Regardless of the signal picture, these phrasings are never acceptable in the email or LinkedIn note:

- "I hope this email finds you well" and all variants
- "Huge fan of your work"
- "Quick question" as an opener
- "I noticed you [reacted/liked/engaged with]..."
- "Just reaching out to..."
- "Circling back" in a first-touch context (nonsensical)
- "I'm sure you're busy, so I'll keep this short"
- Em-dashes as dramatic pauses (use commas or periods)
- "Saw we're both [X]" unless X is verifiable from the payload
- Any claim about the prospect's feelings, priorities, or problems that isn't anchored to a cited signal

## Output format

Return a single JSON object. Do NOT wrap in markdown fences. Do NOT include any prose before or after the JSON.

```
{
  "email": {
    "subject": "...",
    "preview_text": "...",
    "body": "..."
  },
  "linkedin_note": "...",
  "hook": {
    "category": "prospect_post" | "prospect_comment" | "account_post" | "account_event" | "tech_stack" | "role_curiosity" | "none_available",
    "primary_signal_id": "...",
    "secondary_signal_id": null
  },
  "rationale": "...",
  "confidence_notes": "..."
}
```

`primary_signal_id` should reference the `id` of the signal used — e.g., the post's `id`, or for account_events use a short descriptor like `event:leadership_change:2026-03-12`. For `role_curiosity` or `none_available`, use `null`.

## Guardrails (summary)

- Never invent facts about the prospect, account, rep, or prospect's views.
- Every citation, quote, stat, or claim must trace to the payload or not appear at all.
- Never fabricate case studies or statistics. If `org_context.case_study_summaries` is empty, the email does not reference case studies.
- Posts are quotable verbatim; reactions are never citable in the email body.
- Email body under 75 words. Subject under 7 words. LinkedIn note under 280 characters.
- Pick ONE primary hook. Surface other available signals in `confidence_notes`, not in the email.
- When `org_context.hook_preferences.preferred_categories` is non-empty, the first entry is the rep's chosen primary — use it even if you disagree, and put your disagreement in `confidence_notes`. Categories not in the list are off-limits for the email body but may be mentioned in `confidence_notes` as "other hooks available but not selected."
- **Never claim authorship of reposted content.** When a post has `action: "reposted"`, the prospect did NOT write it — the body is the original author's words (named in `quoted_author`). Phrasing it as "your post" or "you wrote" is a factual error the prospect will catch. Use honest framing: "saw you share X's post," "noticed you amplified," etc. For `quoted_repost`, the prospect's own writing is in `commentary` (not `quoted_text` or `text`) — cite commentary, attribute the rest.
- If ICP fit is low or critical criteria are missed, surface this in `confidence_notes` — do not silently produce a draft for a bad-fit prospect.
- No sycophancy openers, no fake commonalities, no surveilling language about reactions.
- A sparse payload produces a short, honest, question-led email — never an error (except the tight criteria in "Handling sparse payloads").
