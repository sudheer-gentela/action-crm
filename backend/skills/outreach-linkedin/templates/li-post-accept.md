# LinkedIn Post-Accept Message Template

The post-accept message is the first direct DM after the prospect accepts the connection request. This is the right step to ask for a meeting — the connection note couldn't.

## When this template applies

The caller passed `step_intent: 'post_accept_message'`. `engagement_history` should contain a `linkedin_connection_accepted` event from the prospect. If it doesn't, the dispatcher made a mistake — flag and default to connection_request behaviour.

## Hard constraints

- **HARD CAP: 1000 characters.** DMs longer than this drop conversion sharply. Target 400-700 characters.
- **3-5 sentences.** No fewer than 3 (the DM has work to do), no more than 5 (more reads as a wall of text).
- **No links** (LinkedIn de-ranks them in DMs the same as in connection notes). If you need to reference an article or case study, name it in plain text — the rep can paste the link manually after.
- **Acknowledge the acceptance** if it was recent (within 7 days). Skip the acknowledgement if it's older — feels awkward.

## Structure

**Sentence 1** (acceptance acknowledgement, conditional): "Thanks for connecting, [first name]." Skip if the acceptance is older than 7 days; jump straight to sentence 2.

**Sentence 2** (hook continuation): Extend the hook used in the connection request — don't restate it. If the connection note said "your post on playbook execution lined up with something we think about," the DM might say "the specific question of how leadership knows the playbook is being followed in week 1 is what GoWarmCRM solves."

**Sentence 3-4** (relevance + soft value): One concrete thing the rep can offer. EITHER a meeting ask OR a useful resource — not both.
  - Meeting ask form: "Worth 20 minutes to compare notes on how [peer companies] are approaching this?"
  - Resource form: "Happy to send a 1-pager on how we think about leading-indicator visibility — useful for any sales leader regardless of whether GoWarmCRM is the right fit."

**Sentence 5** (optional close, only when needed for clarity): "Either way — appreciate the connection."

## Tone

Warmer than the connection note. The prospect has now opted in to the channel; you've earned slightly more space, but not much. The DM equivalent of "now that we're connected, here's something specific" — NOT "now that we're connected, let me pitch you fully."

## Sign-off

First name only. Same as the connection note. No company tagline (their profile shows it).

## Example post-accept messages

**Meeting-ask form** (~520 characters):

```
Thanks for connecting, Maya.

The specific question your post raised — how leadership knows whether the playbook is being followed in week 1, not just at QBR — is exactly what we built GoWarmCRM around. It sits on top of Salesforce and surfaces leading-indicator execution signals.

Worth 20 minutes to compare notes on how a few peer growth-stage SaaS heads are approaching this?

Sudheer
```

**Resource form** (~480 characters):

```
Thanks for connecting, Devin.

Saw the Ferrovia revops note last week — given the timing of your move from Formica, the next 60 days are usually when the execution gap shows up loudest.

Happy to send a short writeup on how a few sales leaders we work with are structuring their week-1 visibility post-rebuild — useful regardless of whether GoWarmCRM is the right fit.

Sudheer
```

## What must never appear in the body

- The same hook quote/citation used in the connection request, verbatim (the prospect just read it; don't repeat)
- "Now that we're connected, I'd love to show you a demo"
- Calendly links
- "Thanks for connecting" + "Let me know if you'd like to chat" — these are placeholders, not a message
- A pitch longer than the relevance sentence
- "I'd love to learn more about your role/company" — research-shifting onto the prospect is lazy
- "Quick question" as an opener
- "@" mentions of other LinkedIn users
