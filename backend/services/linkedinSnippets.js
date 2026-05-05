// ─────────────────────────────────────────────────────────────────────────────
// services/linkedinSnippets.js
//
// Surface B Phase 3 — single source of truth for "what LinkedIn data the AI
// saw when it generated this draft." Builds two artifacts from the same
// source so they're guaranteed in sync:
//
//   1. promptBlock — the text injected into the AI user prompt
//   2. provenance  — the JSONB written to sequence_step_logs.personalize_sources,
//                    used to render the rep-facing footer
//
// Inputs
// ──────
//   profile  — a row from linkedin_profiles (or null if no capture yet)
//   config   — resolved 5-flag personalize config (output of resolvePersonalizeConfig)
//
// Both artifacts only include sections where the corresponding flag is true.
// If no flag is true, or profile is null, both artifacts are null/empty.
// ─────────────────────────────────────────────────────────────────────────────

// ── Formatting helpers — mirror frontend LinkedInDataDrawer for consistency ──

function formatMonthRange(months) {
  if (!months || months < 1) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}mo`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}mo`;
}

function formatExpDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function cleanRelativeTime(s) {
  if (!s) return '';
  return s.replace(/\s*[•·]\s*Edited\s*[•·]?\s*$/i, '')
          .replace(/\s*[•·]\s*$/, '')
          .trim();
}

function buildExpSnippet(exp) {
  const start = formatExpDate(exp.start_date);
  const end   = exp.end_date ? formatExpDate(exp.end_date) : 'Present';
  const dur   = formatMonthRange(exp.duration_months);
  const dates = start && end ? `${start} – ${end}` : (start || end || '');
  const tail  = [dates, dur].filter(Boolean).join(' · ');
  const head  = [exp.title, exp.company].filter(Boolean).join(' at ');
  return tail ? `${head} (${tail})` : head;
}

function buildEduSnippet(ed) {
  const yrs = ed.start_year && ed.end_year ? ` (${ed.start_year}–${ed.end_year})` : '';
  const detail = [ed.degree, ed.field_of_study].filter(Boolean).join(', ');
  return detail ? `${ed.school}, ${detail}${yrs}` : `${ed.school}${yrs}`;
}

function buildActivitySnippet(item) {
  const rel = cleanRelativeTime(item.relative_time) || 'recently';
  const text = item.text ? item.text.slice(0, 220).trim() : '';
  const kindWord = item.kind === 'reaction' ? 'reacted to' : (item.kind === 'comment' ? 'commented' : 'posted');
  if (!text) return `They ${kindWord} ${rel}`;
  return `Their ${item.kind || 'post'} from ${rel}: "${text}${item.text.length > 220 ? '…' : ''}"`;
}

// jsonb columns may arrive as objects (node-postgres default) or as strings
// (depending on pool config). Normalize both.
function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; }
    catch { return []; }
  }
  return [];
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build the AI prompt block + provenance object for a single step.
 *
 * @param {object|null} profile  — linkedin_profiles row (or null)
 * @param {object}      config   — resolved 5-flag personalize config
 *
 * @returns {{
 *   promptBlock: string|null,    // null if nothing to inject
 *   provenance:  object|null,    // { fields_used, snippets, captured_at } or null
 * }}
 */
function buildLinkedInArtifacts(profile, config) {
  if (!profile || !config) return { promptBlock: null, provenance: null };

  const fieldsUsed = [];
  const snippets   = [];

  // ── current_role: headline + experience[0] ────────────────────────────────
  if (config.current_role) {
    const exp = asArray(profile.experience);
    const exp0 = exp[0];
    const parts = [];
    if (profile.headline) parts.push(`Headline: ${profile.headline}`);
    if (exp0) parts.push(`Current role: ${buildExpSnippet(exp0)}`);
    if (parts.length) {
      fieldsUsed.push('current_role');
      snippets.push({ field: 'current_role', value: parts.join(' · ') });
    }
  }

  // ── prior_roles: experience[1..] ──────────────────────────────────────────
  if (config.prior_roles) {
    const exp = asArray(profile.experience);
    if (exp.length > 1) {
      const priors = exp.slice(1, 4).map(buildExpSnippet).filter(Boolean);
      if (priors.length) {
        fieldsUsed.push('prior_roles');
        snippets.push({ field: 'prior_roles', value: priors.join(' · ') });
      }
    }
  }

  // ── recent_activity: activity array ───────────────────────────────────────
  if (config.recent_activity) {
    const acts = asArray(profile.activity);
    // Take up to the 3 most-recent items the rep is most likely to reference.
    const recent = acts.slice(0, 3).map(buildActivitySnippet).filter(Boolean);
    if (recent.length) {
      fieldsUsed.push('recent_activity');
      // One provenance entry per activity item so the rep can see exactly
      // which post/comment the AI was looking at.
      acts.slice(0, 3).forEach(a => {
        const v = buildActivitySnippet(a);
        if (v) snippets.push({ field: 'recent_activity', value: v });
      });
    }
  }

  // ── education ─────────────────────────────────────────────────────────────
  if (config.education) {
    const ed = asArray(profile.education);
    if (ed.length) {
      const edSnips = ed.slice(0, 3).map(buildEduSnippet).filter(Boolean);
      if (edSnips.length) {
        fieldsUsed.push('education');
        snippets.push({ field: 'education', value: edSnips.join(' · ') });
      }
    }
  }

  // ── about_headline: about + headline together ─────────────────────────────
  if (config.about_headline) {
    const parts = [];
    if (profile.headline) parts.push(`Headline: ${profile.headline}`);
    if (profile.about)    parts.push(`About: ${String(profile.about).slice(0, 600).trim()}`);
    if (parts.length) {
      fieldsUsed.push('about_headline');
      snippets.push({ field: 'about_headline', value: parts.join('\n') });
    }
  }

  if (fieldsUsed.length === 0) {
    return { promptBlock: null, provenance: null };
  }

  // ── Build prompt block — verbatim same wording as snippets so the rep's
  //    provenance footer matches what the AI actually saw. Stable wording
  //    instructions live in the route, not here.
  const lines = ['CAPTURED LINKEDIN DATA (use only where it adds genuine specificity — do not invent details, do not reference fields that are empty):'];
  for (const s of snippets) {
    lines.push(`  - [${s.field}] ${s.value}`);
  }

  return {
    promptBlock: lines.join('\n'),
    provenance: {
      fields_used: fieldsUsed,
      snippets,
      captured_at: profile.last_captured_at || null,
    },
  };
}

module.exports = {
  buildLinkedInArtifacts,
};
