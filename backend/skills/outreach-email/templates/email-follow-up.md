# Follow-Up Email Template

The follow-up is a second or third touch after a first email went unanswered. The structure is different from `email-first-touch.md` — shorter, lighter, with a different angle.

## When this template applies

The caller passed `step_intent: 'follow_up'`. `engagement_history` should contain at least one prior outbound `email_sent` event from the rep to this prospect. If it doesn't, the dispatcher made a mistake — flag in `confidence_notes` and default to first-touch behaviour.

## Hard constraints

- **Body under 60 words.** (Tighter than first touch's 75.)
- **2-3 sentences.** Often just 2.
- **Subject line under 7 words.** Either a fresh subject OR a reply-thread continuation (DO NOT fake `Re:` — the email tool will handle threading on the rep's side if they send as a reply).
- **Preview text under 12 words.** Same rules as first touch.

## Body structure

Two patterns work for follow-ups. Pick one based on the prior email's hook.

### Pattern A — Different angle ("new hook")

The first email led with hook X. This follow-up leads with a different hook (account event, tech stack, role curiosity — whatever the payload supports that wasn't used in the first email).

**Sentence 1**: Reference the prior touch briefly without re-pitching. "Saw my note from last week may have landed during a busy stretch."

**Sentence 2**: New hook + bridge in one move. "Wanted to flag [new signal] specifically since [bridge to product]."

**Sentence 3 (optional)**: Soft ask — easier than the first ask. "Worth 15 minutes, or should I close the loop?"

### Pattern B — Soften the ask

The first email's hook was strong; the prospect just didn't reply. This follow-up keeps the hook but shrinks the ask.

**Sentence 1**: Acknowledge silence without guilt-tripping. "Wanted to follow up on the note about [topic from prior subject]."

**Sentence 2**: The reduced ask. "If now's not the moment, no worries — happy to circle back next quarter if more useful." OR: "Would either you or [likely other persona at the account] be the right person?"

That's it for Pattern B. No bridge, no re-pitch. The first email did the pitching.

## Sign-off

Same as first touch. Rep's name only; no "Best/Cheers."

## Example follow-ups

**Pattern A** (first touch used `prospect_post`; follow-up shifts to `account_event`):

```
Subject: ferrovia's new revops hire

Preview: cleaner angle than my note last week

Saw Devin's move from Formica posted on Friday — that usually means the playbook gets a real rebuild in the next 90 days.

What we built GoWarmCRM around is making the rebuild visible in week-one execution instead of waiting on QBR data. Worth 15 minutes, or should I close the loop?

Sudheer
```

**Pattern B** (first touch used `prospect_post`; follow-up softens the ask):

```
Subject: re: your post on playbook execution

Preview: closing the loop on my last note

Wanted to follow up on the note about playbook adoption being 10% of the work.

If now's not the moment, no problem — should I close the loop, or worth picking back up next quarter?

Sudheer
```

## What must never appear in a follow-up body

- The same hook quote/citation used in the prior email (the prospect saw it once; repeating it is annoying)
- A pitch the first email already made
- "Just wanted to follow up" — the structural follow-up doesn't need to announce itself
- "Circling back" — the line is allowed nowhere in a cold-touch sequence
- Guilt-tripping language ("you may not have seen my last note")
- Forwarded-headers (`> On Tuesday I wrote:`) — that's the email tool's job if the rep sends as a reply, and it shouldn't appear in the skill output
- "Re:" prefix added by the skill — the rep's tool handles that
