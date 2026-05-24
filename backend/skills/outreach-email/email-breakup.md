# Breakup Email Template

The breakup is the final email in a sequence. Several follow-ups went unanswered. This email is a courtesy — give the prospect a clean exit, leave the door open for the future, do NOT pitch again.

## When this template applies

The caller passed `step_intent: 'breakup'`. The dispatcher only passes this intent when the sequence step has `step_intent='breakup'` explicitly set — it's never auto-inferred. If you receive `breakup` and the sequence shape doesn't justify it, fall back to `follow_up` behaviour and flag in `confidence_notes`.

## Hard constraints

- **Body under 40 words.** Strict. Brevity is the point of this email.
- **Exactly 2 sentences.** Sometimes 1.
- **Subject line under 7 words.** "closing the loop" / "should I move on?" / "last note from me" all work.
- **No pitch.** No bridge. No hook beyond "this is the last one." The first emails did the pitching; you're not selling here, you're closing politely.

## Body structure

**Sentence 1**: State that this is the last email. Don't be theatrical. "Going to stop reaching out on this." OR: "Last note from me — wanted to close the loop."

**Sentence 2**: Binary, easy-to-ignore ask. "Reply 'not now' and I'll circle back next quarter — otherwise, no worries." OR just: "Happy to revisit if anything changes on your side."

That's it.

## Sign-off

Rep's name only. No company tagline, no signature block beyond what's already in `org_context.rep.email_signature` (if any).

## Example breakups

**Standard**:

```
Subject: closing the loop

Preview: stopping the follow-ups — no hard feelings

Going to stop reaching out on this for now. If the timing changes, reply with anything at all and I'll pick back up — otherwise no worries.

Sudheer
```

**Even shorter**:

```
Subject: last note from me

Preview: no worries either way

Last note from me on this. Happy to revisit if anything changes on your side.

Sudheer
```

## What must never appear in a breakup body

- A new pitch. "One last thing I wanted to mention…" — no.
- A new case study or stat. The breakup is not another touch in disguise.
- Guilt-tripping. "I'm not sure if you saw my last few notes…"
- A demand. "Just let me know either way!" — pushy.
- "Re:" prefix added by the skill — let the rep's tool handle threading.
- Any reference to a specific signal (hook). The hook anchored the first touch; the breakup is generic by design.
- "P.S." — marketing tell.
- Long sign-offs. "Wishing you the best with [thing]" reads as passive-aggressive in a breakup context. Just sign your name.

## Why no hook?

Breakups that anchor to a signal ("circling back on your post about X") read as a sleazy bait-and-switch — the prospect knows the rep is pretending the email is something other than what it is. A breakup that simply states "I'll stop, here's how to revive if you want" respects the prospect's time and converts at higher rates because the prospect can act or not act with low friction.
