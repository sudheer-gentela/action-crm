# MEDDPICC Reference

The qualification framework GoWarmCRM uses to track deal health. Use this to identify the biggest gaps in a deal's payload and prioritize discovery questions accordingly.

## The elements

**M — Metrics**
The quantified business outcome the prospect would achieve. "Reduce forecast error by 30%", "save 10 hours/week/rep", "cut ramp time from 6 months to 3." Without metrics, there's no ROI story, which means the deal will stall at procurement.

**E — Economic Buyer**
The single person who can say yes and unlock budget. Often not the person you're talking to. Signs they are NOT the economic buyer: "I'd need to check with my boss", "we'd have to go to finance", "my team would use this but the decision is above me."

**D — Decision Criteria**
The explicit criteria by which the prospect will evaluate vendors. Technical, functional, commercial. If you don't know their criteria, you can't position against them.

**D — Decision Process**
The actual sequence of steps from "interested" to "signed contract." Who reviews, who signs, what legal looks like, what procurement looks like, what the security review process is.

**P — Paper Process**
Specifically the legal/procurement/security mechanics. How long does it take? Who are the blockers? Have they bought similar tools before (and how long did it take)?

**I — Identify Pain**
The specific, named business pain — ideally with a cost or impact attached. Not "we could do better at X" but "we missed our Q3 number because X."

**C — Champion**
Someone internal who WANTS you to win and has the political capital to help you win. Not just a friendly contact. A champion will give you information, advocate for you internally, and coach you through the process.

**C — Competition**
Who else is being evaluated, including "do nothing" and "build in-house." If you don't know, assume a competitor exists.

## Prioritization for discovery calls

In a first discovery call, the realistic priorities are:
1. **Identify Pain** — if there's no named pain, the rest doesn't matter
2. **Champion** — is this person potentially a champion, and if not, who is?
3. **Metrics** — can we attach a number to the pain?
4. **Decision Process** — rough map of who else is involved

Later calls cover: Economic Buyer (confirm, not assume), Decision Criteria (what specifically they'll evaluate on), Paper Process, Competition.

## Reading gaps from the payload

When you examine the `meddpicc` object in the deal payload:
- Empty or missing fields = ask about them in the call
- Filled fields = confirm or probe deeper rather than re-ask
- Stale fields (last touched >30 days ago) = confirm still accurate

If `champion` is empty but the prospect has had 3+ engaged interactions, explore whether this prospect could be the champion. If `champion` is named and it's not the person on the call, ask how they're working together.
