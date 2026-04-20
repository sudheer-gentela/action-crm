// gowarm-backend: add this as a new route file
// e.g. routes/skill-context.js
//
// Purpose: expose a canonical, CRM-agnostic deal payload for skill consumption.
// This is the ONLY endpoint the skill runner calls. It composes existing
// queries into the schema defined by skills/*/schema/gowarm-deal.json.
//
// Auth: protected by a service token (SKILL_RUNNER_TOKEN) — not user JWT.
// This is a backend-to-backend call, not a user-facing route.

const express = require("express");
const router = express.Router();

// Middleware: validate the service token on every call
function requireSkillRunnerToken(req, res, next) {
  const token = req.headers["x-skill-runner-token"];
  if (!token || token !== process.env.SKILL_RUNNER_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// GET /api/skill-context/deals/:dealId
//
// Returns the deal payload in the shape expected by the skill runner.
// This is where your field_map resolution runs — the response uses
// canonical semantic field names, NOT raw Salesforce custom field IDs.
router.get("/deals/:dealId", requireSkillRunnerToken, async (req, res) => {
  try {
    const { dealId } = req.params;

    // Replace these with your actual data access layer calls.
    // The idea is to REUSE existing queries — don't write new DB logic here.
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: "deal_not_found" });

    const prospect = await getProspectForDeal(dealId);
    const account = await getAccountForDeal(dealId);
    const interactions = await getInteractionHistory(dealId, { limit: 10 });
    const meddpicc = await getMeddpiccSnapshot(dealId);

    // Apply field_map to resolve CRM-specific fields to canonical names.
    // If your backend already does this in the query layer, you can skip here.
    const payload = {
      prospect: {
        name: prospect.name,
        title: prospect.title,
        company: account.name,
        linkedin_url: prospect.linkedin_url || undefined,
        email: prospect.email,
        tenure_in_role_months: prospect.tenure_in_role_months || undefined,
      },
      account: {
        industry: account.industry,
        size: account.size_band,
        revenue_band: account.revenue_band,
        recent_signals: account.recent_signals || [],
      },
      deal: {
        stage: deal.stage,                // e.g. 'discovery_call'
        source: deal.source,              // 'inbound' | 'outbound' | ...
        playbook_id: deal.playbook_id,
        created_at: deal.created_at,
        amount: deal.amount,
        days_in_stage: deal.days_in_stage,
      },
      interaction_history: interactions.map(i => ({
        type: i.type,
        timestamp: i.timestamp,
        summary: i.summary,
        direction: i.direction,
      })),
      meddpicc: {
        metrics: meddpicc?.metrics || null,
        economic_buyer: meddpicc?.economic_buyer || null,
        decision_criteria: meddpicc?.decision_criteria || null,
        decision_process: meddpicc?.decision_process || null,
        paper_process: meddpicc?.paper_process || null,
        identified_pain: meddpicc?.identified_pain || null,
        champion: meddpicc?.champion || null,
        competition: meddpicc?.competition || null,
      },
    };

    res.json(payload);
  } catch (err) {
    console.error("skill-context fetch failed:", err);
    res.status(500).json({ error: "internal_error", message: err.message });
  }
});

module.exports = router;

// Then in your main app.js / server.js:
// const skillContext = require("./routes/skill-context");
// app.use("/api/skill-context", skillContext);
