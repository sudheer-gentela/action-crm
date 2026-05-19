# MEDDIC Methodology Lens

When this methodology is selected, apply the MEDDIC qualification framework to the discovery call. MEDDIC is an enterprise-sales methodology that treats every discovery call as a chance to fill specific qualification fields. A call is successful if it meaningfully advances 2-3 MEDDIC fields, regardless of whether the prospect commits to a next step.

## Core philosophy

MEDDIC reps treat selling as a structured information-gathering exercise. The framework is the work. If a deal can't be qualified against MEDDIC, it's not a deal — it's a wish. A skilled MEDDIC rep would rather walk away from a call having confirmed a deal is unqualified than fake forward momentum.

The call is graded on what was *learned*, not what was sold.

## How this changes the prep brief

Lead the prep brief with **a MEDDIC scorecard**: which of the six fields are filled, which are gaps, which are stale (>30 days old). The most important section of the brief is **"What MEDDIC fields must come out of this call"** — name 2-3 specific gaps and what a good answer would look like.

Frame the call's success criteria in MEDDIC terms. Not "did we book a demo" but "did we identify the Economic Buyer."

## How this changes the talk track

**Opening:** Frame the call as discovery, not sales. Earn permission to ask questions in a structured way. A MEDDIC-style opening:

> "I want to understand four or five things today — your situation, the people involved, the metrics that matter, and your decision process. If we both like what we hear, we can talk about what next looks like."

**Context confirmation:** Confirm Pain and Champion-candidate facts you already know. These are the two most important MEDDIC fields and the two most often misunderstood from CRM data.

**Discovery questions:** Selected to target specific MEDDIC field gaps in priority order. Each question maps to one field. Annotate questions with the MEDDIC field they target:

> "What number on your dashboard would have to move for you to call this a win?" *(MEDDIC: Metrics)*

**Field-specific question patterns:**

- **Metrics:** "What would success look like quantitatively?" / "What's the cost of doing nothing?" / "What's the dollar value of solving this?"
- **Economic Buyer:** "Walk me through how a decision like this gets made." / "Who has budget for this?" / "If we agreed today, what would it take to get a contract signed?"
- **Decision Criteria:** "What would you evaluate us on?" / "What does 'good' look like to you?" / "What would make you reject a vendor?"
- **Decision Process:** "Walk me through your evaluation steps from here to a signed contract." / "Who reviews? Who signs? What does legal/security/procurement look like?"
- **Identify Pain:** "What happens if this problem isn't solved?" / "When this hurts, who feels it first?" / "What's the cost of the status quo?"
- **Champion:** "Who else lives with this problem?" / "Who would advocate for this internally?" — listen for someone who *wants* you to win, not just someone who's friendly.

**Close:** State explicitly which MEDDIC fields the call advanced, which remain open, and what next step fills the next gap:

> "Today we confirmed the Pain and identified Metrics. The next thing we need to figure out is the Economic Buyer. Can you introduce me to [name they mentioned]?"

## How this changes the email drafts

**Strong signal email:** Reference the specific MEDDIC field advanced. Propose the next step as continuing qualification:

> "You mentioned [specific Pain]. The natural next step is for [Economic Buyer name] to weigh in on whether this aligns with their priorities."

**Weak signal email:** Acknowledge the qualification picture is incomplete. Propose a low-commitment step that fills ONE specific gap. Don't push for a demo or pricing — push for *information*:

> "If you can share who else weighs in on decisions like this, I can put together something more relevant for that group."

## How this changes the next-step recommendation

MEDDIC reps disqualify aggressively. The recommended next step should be:

- `multi_thread` — Champion or Economic Buyer is named but not yet engaged (common after a good discovery call)
- `technical_deep_dive` — Decision Criteria are unclear and the prospect needs product detail to articulate them
- `disqualify` — After the call, 4+ MEDDIC fields are still empty and there's no path to filling them
- `nurture` — Pain is real but timeline is far out (>6 months)

**Avoid recommending `demo` directly out of a discovery call** unless the prospect has earned it (Pain confirmed, Metrics named, Champion candidate identified). MEDDIC philosophy: a demo without qualification is a wasted demo.

## How this changes the confidence notes

Always include a **MEDDIC scorecard** in confidence notes:

> MEDDIC status: Metrics [filled/gap/stale], Economic Buyer [...], Decision Criteria [...], Decision Process [...], Identify Pain [...], Champion [...]

This makes the qualification posture visible to the rep and surfaces what's *known* vs. *assumed*.

## When MEDDIC is the wrong lens

Be honest in `confidence_notes` if MEDDIC isn't a great fit:

- Small deal sizes (<$10K ARR) where qualification overhead exceeds deal value
- Transactional inbound deals where the prospect already knows what they want and is ready to buy
- Self-serve / PLG motions where Decision Process is just "the user signs up"

If you detect this mismatch, note it in confidence notes: "MEDDIC may be over-engineered for this deal size — consider a lighter lens for tighter outputs."
