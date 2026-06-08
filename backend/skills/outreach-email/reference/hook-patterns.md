# Hook Patterns

The primary hook decides the opener, bridge, and ask. This file is the detailed structure for each category. `outreach-principles.md` contains the hard rules; this file contains the structural patterns.

## Pattern structure

Every cold email has three parts:

1. **Opener** (1 sentence): the hook. Why you're reaching out *now*, to *this* person.
2. **Bridge** (1-2 sentences): connects the hook to the rep's product. This is where the relevance is made explicit.
3. **Ask** (1 sentence): one specific, low-commitment next step.

Total: 3-4 sentences, under 75 words.

## Pattern 1 — Prospect's own recent post

When the prospect has **authored a post in the last two weeks** stating a view, problem, or question the product addresses.

Eligibility is strict and enforced upstream — `signals.linkedin_activity.posts` contains ONLY the prospect's own posts (original, or their own commentary on a quoted repost) from the last 14 days. `comments` and `reactions` arrive empty and are **never** a hook: do not anchor on anything the prospect commented on, replied to, or reacted to — only on what they themselves posted. If `posts` is empty, fall through to the next pattern.

**Opener**: Reference the post specifically, with a short verbatim quote (under 15 words) if the line lands. Cite timing — it is recent by construction.

**Bridge**: Connect the prospect's stated view to the product — not as a pitch ("we solve that!") but as a relevance signal ("the thing you described is specifically what [product] is built for").

**Ask**: Curiosity-framed. Not a demo request on first touch. "Happy to share how we think about this" or "worth a 20-min compare-notes conversation?"

**Example scaffold**:
> Saw your post from [timing] — the line about [quoted fragment, under 15 words] is almost exactly what we built [product] around.
>
> [One sentence: the product's angle on that specific problem, drawn from org_context.value_props.]
>
> Worth a 20-min conversation, or would you rather I send over how we think about it first?

**What to avoid**:
- Don't quote more than one fragment from the post — one is specific, two is stalking.
- Don't tell the prospect what they "really meant" in their post.
- Don't add "I've been thinking about this problem for years" or similar credibility-seeking — let the relevance speak for itself.

## Pattern 1b — Prospect's profile (about + experience)

When there is no recent post but the prospect's own profile gives something specific to anchor on. Two prospect-stated sources (not inferred):

- `prospect.about` — the prospect's own summary. Anchor on a stated focus, mandate, or priority.
- `prospect.experience` — role history: current-role tenure ("six months into the CRO seat at [company]"), a recent move into the role, or a clear trajectory.

Genuinely personalized (their words, their record) but **static**, so it ranks below a fresh post and a recent account event, and above the generic fallbacks (tech stack, role-and-stage curiosity).

**Opener**: Anchor on the specific bio fact, stated plainly. Do not read motives into it.

**Bridge**: Connect the stated mandate/tenure to the predictable challenge the product addresses, flagged as a common pattern.

**What to avoid**:
- Don't quote the about section at length — paraphrase the one relevant idea.
- Don't infer intent the profile doesn't state.
- Don't use this if `about` and `experience` are both empty — fall through.

## Pattern 2 — Account trigger event

When a funding round, leadership change, hiring surge, product launch, or similar event has happened recently.

**Opener**: Name the event specifically, including who and when if known. Avoid generic "saw your news."

**Bridge**: Connect the event to a predictable downstream challenge the product addresses. This is inference — flag it as such ("usually means...") rather than stating as fact about the prospect.

**Ask**: Time-sensitive but not pressuring. "As you're scaling into this" or "while the dust is still settling."

**Example scaffold**:
> Saw Ferrovia's Series B extension in January and [CRO name]'s move over from [prev company] last month.
>
> In growth-stage rebuilds like this, the execution gap between what leadership plans and what reps actually run tends to widen before it narrows. That's specifically what [product] is built around.
>
> Worth a 20-min conversation while you're still scoping the playbook?

**What to avoid**:
- Don't congratulate the company on the funding. It's condescending.
- Don't pretend you know the prospect's strategy because you read the press release.
- Don't stack multiple events in the opener. Pick the most recent or most relevant.

## Pattern 3 — Peer social proof

Only usable when `org_context.case_study_summaries` is non-empty AND a case study customer is a close parallel to this prospect's company.

**If case studies are empty, skip this pattern entirely. Do not fabricate.**

**Opener**: Name the parallel — same stage, same industry, similar role. Anonymize the customer if the case study does.

**Bridge**: What specifically the parallel company changed or achieved. Use the case study's stat verbatim or not at all.

**Ask**: Reference-led. "Happy to walk through what they did."

**Example scaffold**:
> [Rep name] at [product] here. We work with [close parallel — e.g., "another growth-stage B2B SaaS at around your size"] — [case study customer name or "a customer"] had the same [problem pattern].
>
> [Case study summary, verbatim or closely drawn from org_context.]
>
> Worth a short call to walk through what they did?

**What to avoid**:
- Never fabricate a stat. "40% improvement" when the payload has no stat is a fabrication.
- Don't claim a customer by name unless `case_study_summaries` specifies they can be named (check the `customer` field — anonymized entries say "a [description]").
- Don't claim the prospect's company "looks just like" the case study — it's a tell.

## Pattern 4 — Tech stack overlap

When the prospect's `tech_stack` includes a tool that meaningfully pairs with or signals relevance for the product.

**Opener**: Name the specific tool and why its presence is interesting.

**Bridge**: What the product adds to or alongside that tool.

**Ask**: Technical-curious framing.

**Example scaffold**:
> Noticed Ferrovia is on Salesforce + Gong + Outreach — that's the exact stack we built [product] to sit on top of.
>
> [One sentence on what the product does specifically in that stack context — drawn from org_context.value_props.]
>
> Worth a 15-min walkthrough of how it plugs in?

**What to avoid**:
- Don't teardown the prospect's current stack. "You're probably frustrated with X" is a paraphrase failure.
- Don't assume the presence of a tool means the prospect chose it or likes it — they may have inherited it.
- Don't list every tool in their stack. Name one or two that matter.

## Pattern 5 — Role and stage curiosity

The fallback when no stronger hook is available. This is honest, short, and question-led. Do not pretend it's something stronger.

**Opener**: State directly what the rep does and who they work with. No research performance.

**Bridge**: A one-sentence framing of the problem pattern the prospect's role typically faces at their company's stage.

**Ask**: A genuine, answerable question. Not a demo request.

**Example scaffold**:
> [Rep name], founder of [product] here. We work with VP Sales at growth-stage B2B SaaS on [problem category drawn from org_context].
>
> Curious whether [specific question tied to the role + stage] is on your list this quarter — or is it further down?
>
> Either way, happy to share how a few sales leaders are thinking about it.

**What to avoid**:
- Don't pretend to have researched the prospect when you haven't. The email is shorter precisely because there's less to say.
- Don't ask "are you the right person?" — it admits the rep didn't do basic qualification.
- Don't load this template with the same confidence as the stronger hooks. The brevity is the feature.

## Choosing between hooks

When multiple hooks are available, the tiebreakers:

- **Recency + specificity, in this order:** a fresh own-post (Pattern 1) > a recent account event (Pattern 2) > the prospect's bio/experience (Pattern 1b) > the generic fallbacks (case-study parallel, tech stack, role-and-stage curiosity).
- **Specificity wins** within a tier. A quote from the prospect beats a firmographic generality.
- **Concreteness wins.** A tech stack fact beats a persona inference.
- **Honesty wins.** A weak hook you can fully defend beats a strong hook you partially fabricated.

## When nothing specific qualifies — flag it

The fallbacks exist so every prospect gets a usable draft and the queue keeps moving. But the rep must know when a draft is *generic* rather than *specifically personalized*:

- If the chosen hook is `role_curiosity`, `tech_stack`, or `none_available` — no fresh own-post, no recent account event, no usable bio anchor, no researcher note — you MUST say so plainly in `confidence_notes`, e.g. `"No recent prospect post, account event, or bio anchor — generic role-curiosity fallback."`
- If nothing supports even a role-curiosity opener, set `hook.category = "none_available"`, produce the most honest short artifact you can, and flag the absence of personalization data in `confidence_notes`.
- Never manufacture specificity to avoid the flag.

Log the chosen hook in the `hook` field of the output, with the signal `id` so the rep can trace back to the source.
