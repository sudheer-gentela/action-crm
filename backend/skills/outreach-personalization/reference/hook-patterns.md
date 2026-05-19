# Hook Patterns

The primary hook decides the opener, bridge, and ask. This file is the detailed structure for each category. `outreach-principles.md` contains the hard rules; this file contains the structural patterns.

## Pattern structure

Every cold email has three parts:

1. **Opener** (1 sentence): the hook. Why you're reaching out *now*, to *this* person.
2. **Bridge** (1-2 sentences): connects the hook to the rep's product. This is where the relevance is made explicit.
3. **Ask** (1 sentence): one specific, low-commitment next step.

Total: 3-4 sentences, under 75 words.

## Pattern 1 — Prospect's own words

When the prospect has authored a recent post or substantive comment stating a view, problem, or question the product addresses.

**Opener**: Reference the post or comment specifically, with a short verbatim quote if the line lands. Cite timing if recent.

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

- **Recency wins.** A post from last week beats an account event from 3 months ago.
- **Specificity wins.** A quote from the prospect beats a firmographic generality.
- **Concreteness wins.** A tech stack fact beats a persona inference.
- **Honesty wins.** A weak hook you can fully defend beats a strong hook you partially fabricated.

Log the chosen hook in the `hook` field of the output, with the signal `id` so the rep can trace back to the source.
