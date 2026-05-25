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

## Pattern 6 — Researcher override

Used ONLY when `signals.researcher_note` is non-null AND `signals.researcher_note.override` is true. A human researcher has explicitly flagged something about this prospect that should drive the message — typically context that isn't in the LinkedIn activity feed or account enrichment (a conversation at a conference, a referral from a mutual contact, a topic the prospect raised in a podcast the rep listened to, a press mention not yet in the enrichment data).

The note is the hook. You do not pick a different hook even if a stronger-looking signal exists in the activity feed — the researcher saw something the auto-detection didn't.

**Opener**: Anchor on the substance of the researcher's note. If the note has a source URL or attribution that you can cite naturally, do so. If it doesn't, frame the observation honestly — "a colleague flagged X" or "saw a note that you'd been thinking about Y" — rather than pretending you read the prospect's own post.

**Bridge**: Connect the substance of the note to the product. This works the same way as Patterns 1 and 2 — the prospect's stated view or situation is the relevance signal.

**Ask**: Curiosity-framed. Tone-match the specificity of the note: a concrete note ("she mentioned at the panel that data fragmentation is their #1 issue") supports a more targeted ask than a vague one ("seemed interested in scaling").

**Example scaffolds**:

When the note is concrete with attribution:
> Picked up on a note from your panel at [event] — the line about data fragmentation in fleet ops being your #1 issue is exactly what we built [product] around.
>
> [One sentence: the product's angle on that specific problem.]
>
> Worth a 20-min compare-notes conversation?

When the note is concrete but lacks a citable source:
> A colleague flagged that you're rethinking how your team handles [topic from note].
>
> [One sentence: the product's angle.]
>
> Curious whether that's still active for you, or whether the focus has shifted.

**What to avoid**:
- **Never fabricate a quote.** The researcher's note is a paraphrase, not the prospect's own words. Do NOT put the researcher's wording in quote marks as if the prospect said it.
- **Never fabricate a source.** If the note has no `source_url`, do not invent one ("saw your LinkedIn post"). Use honest attribution ("a colleague flagged", "saw a note that…") or attribute generally ("understand that…").
- **Don't downgrade the override.** If `override` is true and a stronger-looking signal exists in the activity feed, you still use the note as the hook. The researcher made an explicit call; respect it.
- **Don't apologize for the override path.** Don't write "this came from a colleague rather than your LinkedIn." Just write the email; the rep already knows the source.
- **Don't pad with auto-detected signals.** A researcher override email mentions only the researcher's note as the hook. You can use account-level facts (industry, growth stage, tech stack) in the bridge if they're relevant, but don't open with two hooks stacked.

When `signals.researcher_note` is non-null but `override` is false — i.e. hint mode — DO NOT use Pattern 6. Pick a hook from the auto-detected signals (Patterns 1-5) as usual, but you MAY weave the researcher's note into the bridge or ask if it strengthens the email. If it doesn't fit naturally, ignore it. The note is context, not a directive.

## Choosing between hooks

When multiple hooks are available, the tiebreakers:

- **Researcher override wins absolutely** when `signals.researcher_note.override` is true. No other pattern overrides this.
- **Recency wins.** A post from last week beats an account event from 3 months ago.
- **Specificity wins.** A quote from the prospect beats a firmographic generality.
- **Concreteness wins.** A tech stack fact beats a persona inference.
- **Honesty wins.** A weak hook you can fully defend beats a strong hook you partially fabricated.

Log the chosen hook in the `hook` field of the output, with the signal `id` so the rep can trace back to the source. For Pattern 6, use `category: "researcher_override"` and set `primary_signal_id` to the researcher_note's source_url when present, or to `"researcher_note"` literally when no URL exists.
