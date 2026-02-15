/**
 * SALES PLAYBOOK CONFIGURATION
 * Customize this file to match your sales process
 * This guides the AI in generating intelligent actions
 */

const SALES_PLAYBOOK = {
  
  // ============================================================
  // COMPANY INFO (Customize this!)
  // ============================================================
  company: {
    name: "Action CRM",
    industry: "SaaS / CRM Software",
    product: "AI-powered CRM for sales teams",
    pricing: {
      starter: "$49/user/month",
      professional: "$99/user/month", 
      enterprise: "Custom pricing"
    },
    typical_deal_size: {
      smb: "Under $10K",
      mid_market: "$10K - $50K",
      enterprise: "Over $50K"
    }
  },

  // ============================================================
  // DEAL STAGES (Customize your sales process)
  // ============================================================
  deal_stages: {
    
    qualified: {
      goal: "Understand customer needs and qualify fit",
      next_step: "Discovery call",
      timeline: "Within 2 business days",
      key_actions: [
        "Schedule 30-min discovery call",
        "Research company and industry",
        "Identify pain points and goals",
        "Map decision makers and process"
      ],
      email_response_time: "4 hours",
      success_criteria: [
        "Budget confirmed",
        "Timeline identified", 
        "Decision process understood",
        "Pain points validated"
      ]
    },
    
    demo: {
      goal: "Show product value and address use cases",
      next_step: "Product demonstration",
      timeline: "Within 5 business days of qualification",
      key_actions: [
        "Customize demo to pain points",
        "Include technical stakeholders",
        "Prepare ROI calculator",
        "Address specific use cases",
        "Record demo for internal sharing"
      ],
      email_response_time: "2 hours",
      success_criteria: [
        "Demo completed with key stakeholders",
        "Technical questions answered",
        "ROI demonstrated",
        "Next steps agreed upon"
      ]
    },
    
    proposal: {
      goal: "Present pricing and close the deal",
      next_step: "Send detailed proposal",
      timeline: "Within 2 business days of demo",
      key_actions: [
        "Send customized proposal",
        "Follow up within 3 days",
        "Schedule proposal review call",
        "Address pricing concerns immediately",
        "Provide references if requested"
      ],
      email_response_time: "1 hour",
      success_criteria: [
        "Proposal sent and reviewed",
        "Pricing accepted or negotiated",
        "Timeline for decision confirmed",
        "Contract process started"
      ]
    },
    
    negotiation: {
      goal: "Finalize terms and get to signed contract",
      next_step: "Contract finalization",
      timeline: "Close within 2 weeks",
      key_actions: [
        "Address legal concerns within 24h",
        "Involve executive sponsor if needed",
        "Prepare business case justification",
        "Get procurement process details",
        "Set up contract signing process"
      ],
      email_response_time: "30 minutes",
      success_criteria: [
        "All objections addressed",
        "Legal review complete",
        "Contract signed",
        "Implementation scheduled"
      ]
    }
  },

  // ============================================================
  // CONTACT ROLES (How to communicate with each)
  // ============================================================
  contact_roles: {
    
    decision_maker: {
      priority: "highest",
      communication_style: "Strategic, ROI-focused, executive-level",
      response_time: "1 hour",
      meeting_cadence: "Weekly touchpoints during active deals",
      content_type: "Executive briefings, strategic value, ROI analysis, competitive positioning",
      talking_points: [
        "Business impact and outcomes",
        "Strategic alignment with company goals",
        "Risk mitigation",
        "Competitive advantages"
      ]
    },
    
    champion: {
      priority: "high",
      communication_style: "Collaborative, detailed, partnership-oriented",
      response_time: "2 hours",
      meeting_cadence: "Bi-weekly check-ins",
      content_type: "Success stories, internal advocacy materials, product updates, insider tips",
      talking_points: [
        "How to build internal case",
        "Talking points for stakeholders",
        "Success metrics to share",
        "Quick wins to demonstrate value"
      ]
    },
    
    influencer: {
      priority: "medium-high",
      communication_style: "Technical, thorough, detail-oriented",
      response_time: "4 hours",
      meeting_cadence: "As needed for technical discussions",
      content_type: "Technical documentation, integration guides, API docs, security whitepapers",
      talking_points: [
        "Technical capabilities",
        "Integration requirements",
        "Security and compliance",
        "Implementation complexity"
      ]
    },
    
    user: {
      priority: "medium",
      communication_style: "Practical, hands-on, efficiency-focused",
      response_time: "6 hours",
      meeting_cadence: "Monthly during evaluation, quarterly after",
      content_type: "Training materials, best practices, tips & tricks, product tutorials",
      talking_points: [
        "How to accomplish daily tasks",
        "Time-saving features",
        "Workflow improvements",
        "User experience benefits"
      ]
    }
  },

  // ============================================================
  // EMAIL TRIGGERS (What to look for in emails)
  // ============================================================
  email_triggers: {
    
    pricing_question: {
      urgency: "high",
      response_time: "Within 2 hours",
      action: "Respond with pricing and ROI",
      include: [
        "Detailed pricing breakdown",
        "ROI calculator or case study",
        "Discount options if applicable",
        "Payment terms flexibility"
      ],
      escalate_if: "Concerns about budget or pushback on price"
    },
    
    competitor_mention: {
      urgency: "critical",
      response_time: "Within 1 hour",
      action: "Schedule competitive positioning call",
      include: [
        "Comparison sheet highlighting differentiators",
        "Win stories against that competitor",
        "Unique capabilities they lack"
      ],
      escalate_if: "Competitor is significantly ahead in evaluation"
    },
    
    technical_question: {
      urgency: "medium-high",
      response_time: "Within 4 hours",
      action: "Involve solutions engineer or provide docs",
      include: [
        "Technical documentation",
        "Integration examples or guides",
        "API access for testing",
        "Technical POC if needed"
      ],
      escalate_if: "Question is beyond standard capabilities"
    },
    
    timeline_question: {
      urgency: "high",
      response_time: "Within 2 hours",
      action: "Provide implementation plan and timeline",
      include: [
        "Phase-by-phase timeline",
        "Resource requirements",
        "Key milestones",
        "Success metrics"
      ],
      escalate_if: "Timeline is unrealistic or rushed"
    },
    
    objection: {
      urgency: "critical",
      response_time: "Within 1 hour",
      action: "Address objection with evidence",
      include: [
        "Case studies showing success",
        "Risk mitigation strategies",
        "Trial or POC offer",
        "Reference customer intro"
      ],
      escalate_if: "Objection is a deal-breaker"
    },
    
    budget_concern: {
      urgency: "high",
      response_time: "Within 2 hours",
      action: "Discuss payment options and ROI",
      include: [
        "Flexible payment terms",
        "Phased rollout options",
        "ROI justification document",
        "Budget approval template"
      ],
      escalate_if: "Budget is genuinely unavailable"
    },

    security_compliance: {
      urgency: "critical",
      response_time: "Within 1 hour",
      action: "Provide security documentation",
      include: [
        "SOC2 / HIPAA / GDPR docs",
        "Security whitepaper",
        "Compliance certifications",
        "Data handling policies"
      ],
      escalate_if: "Requires custom security review"
    },

    integration_question: {
      urgency: "medium",
      response_time: "Within 4 hours",
      action: "Provide integration documentation",
      include: [
        "Integration guides",
        "API documentation",
        "Pre-built connectors list",
        "Custom integration scope"
      ],
      escalate_if: "Requires custom integration work"
    }
  },

  // ============================================================
  // DEAL VALUE RULES (Adjust based on deal size)
  // ============================================================
  deal_value_rules: {
    
    under_10k: {
      label: "SMB Deal",
      decision_process: "Simple, 1-2 stakeholders",
      timeline: "2-4 weeks",
      approval_needed: "Manager or Director level",
      sales_motion: "Self-serve friendly, light-touch",
      required_docs: ["Pricing", "Basic proposal"]
    },
    
    "10k_to_50k": {
      label: "Mid-Market Deal",
      decision_process: "Standard, 3-5 stakeholders",
      timeline: "4-8 weeks",
      approval_needed: "Director or VP level",
      sales_motion: "Consultative selling, demo required",
      required_docs: [
        "Detailed proposal",
        "ROI analysis",
        "Implementation plan",
        "References"
      ]
    },
    
    over_50k: {
      label: "Enterprise Deal",
      decision_process: "Complex, 5+ stakeholders, committee",
      timeline: "8-16 weeks",
      approval_needed: "VP or C-level",
      sales_motion: "Strategic selling, executive sponsorship",
      required_docs: [
        "Executive briefing",
        "Detailed ROI analysis",
        "Legal review",
        "Security audit",
        "Procurement process",
        "Multi-year roadmap"
      ]
    }
  },

  // ============================================================
  // YOUR CUSTOM RULES (Add your specific process here!)
  // ============================================================
  custom_rules: {
    
    // Example: Healthcare industry specific
    healthcare_specific: {
      always_include: ["HIPAA compliance documentation", "BAA template"],
      key_concerns: ["PHI handling", "Data residency", "Audit logs"],
      response_time: "1 hour for compliance questions"
    },

    // Example: Enterprise customers
    enterprise_customers: {
      always_include: ["SOC2 report", "SLA commitments", "Escalation process"],
      required_meetings: ["Executive briefing", "Technical deep-dive", "Security review"],
      decision_timeline: "Expect 12-16 weeks"
    },

    // Add more as needed...
  }
};

module.exports = SALES_PLAYBOOK;
