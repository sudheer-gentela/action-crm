# LinkedIn Nurture DM Template

The nurture DM is a follow-up message after a prior LinkedIn message went unanswered, OR a check-in after time has passed since the last touch on this channel.

## When this template applies

The caller passed `step_intent: 'nurture_dm'`. `engagement_history` should contain at least one prior `linkedin_message_sent` event. If it doesn't, flag and default to `post_accept_message` behaviour.

## Hard constraints

- **HARD CAP: 800 characters.** Target 300-500.
- **2-3 sentences.** No more than 3.
- **No links, no emails, no @-mentions.**
- **No re-pitching.** The prior DMs did the pitching. This one acknowledges silence and gives an easy exit OR introduces a small new wrinkle.

## Structure

Two patterns work. Pick based on whether the prior DM had a substantive ask that just didn't land.

### Pattern A — Easy out

The prior DM asked for a meeting; no reply. This message acknowledges that the timing may not be right and asks if a future check-in would be better.

**Sentence 1**: Reference the prior touch lightly. "Wanted to circle back on the note from a couple weeks ago." (DM context — "circling back" is acceptable here in a way it isn't in cold email.)

**Sentence 2**: Easy ask. "If now isn't the moment, no worries — should I pick this back up in [a quarter / after Q3 / when X happens]?"

### Pattern B — New small wrinkle

The prior DM offered a resource or made a generic ask. This message adds one new piece of context that might re-engage them — a new case study customer, a published article, a peer in their industry.

**Sentence 1**: Reference the prior touch in one short clause. "Following up on the note from earlier this month —"

**Sentence 2**: The new small wrinkle. "We just published [thing] on [topic] that's specific to [their industry/stage] — happy to share if useful, no obligation."

**Sentence 3 (optional)**: Soft confirmation that no reply is needed. "Otherwise no worries — appreciate the connection regardless."

## What this DM is not

- Not a re-pitch of the original product story
- Not a "Hey, did you see my last message?" guilt nudge
- Not an "I noticed you haven't replied" call-out
- Not a long catch-up DM with multiple new threads

## Sign-off

First name only. Same as other LinkedIn intents.

## Example nurture DMs

**Pattern A — Easy out** (~280 characters):

```
Wanted to circle back on the note from a couple weeks ago about the playbook execution conversation.

If now isn't the right moment, no problem — should I pick this back up in Q3, or close the loop?

Sudheer
```

**Pattern B — New small wrinkle** (~430 characters):

```
Following up on the note from earlier this month —

We just put together a short writeup on what week-1 execution visibility looks like for growth-stage SaaS heads of revenue specifically, drawing on a few customer conversations. Happy to send if useful — no obligation.

Otherwise no worries — appreciate the connection.

Sudheer
```

## What must never appear

- "Just checking in" — the laziest phrasing in cold outreach
- "I know you're busy" — passive-aggressive
- "Wanted to make sure my last note didn't get lost" — guilt-trip
- A full re-pitch of the product
- Multiple asks ("happy to chat OR send a resource OR get on a call OR…") — pick one
- Links — never on LinkedIn DMs in this skill's output
- Asking the prospect to introduce you to someone else at their company (that's a separate skill if we ever build one)
- "P.S." — same as email
