/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAProspectingModule. Includes co-located single-consumer constants/helpers. */
import React, { useState, useEffect } from 'react';
import OAProspectingSkillConfig from '../../OAProspectingSkillConfig';
import OATwilioSettings from '../../OATwilioSettings';
import OrgSendingScheduleSettings from '../../OrgSendingScheduleSettings';
import { apiService } from '../../apiService';
import { ModuleSubTabs, OAModuleGeneral, OAModuleSeedPanel } from '../shared';
import OACallSettings from './OACallSettings';
import OACampaignDeletePolicy from './OACampaignDeletePolicy';
import OAManagerEditPolicy from './OAManagerEditPolicy';
import OAProspectVisibilityPolicy from './OAProspectVisibilityPolicy';
import OAProspectingEnrichment from './OAProspectingEnrichment';
import OAProspectingEscalation from './OAProspectingEscalation';
import OALinkedInAutomation from '../../OALinkedInAutomation';

// ORG_AI_MODELS — hard-coded model catalog, REPLACED 2026-06 by a live fetch of
// GET /org/admin/ai/providers (backend/config/aiProviders.js + ModelDiscovery),
// so the Default Model dropdown reflects the current registry instead of drifting.
// Kept commented as a breadcrumb in case the endpoint is ever unavailable.
// const ORG_AI_MODELS = {
//   anthropic: [
//     { value: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku (fast, economical)' },
//     { value: 'claude-sonnet-4-5-20251022', label: 'Claude Sonnet (balanced)' },
//     { value: 'claude-opus-4-5-20251022',   label: 'Claude Opus (most capable)' },
//   ],
//   openai: [
//     { value: 'gpt-4o-mini', label: 'GPT-4o Mini (fast, economical)' },
//     { value: 'gpt-4o',      label: 'GPT-4o (most capable)' },
//   ],
//   gemini: [
//     { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (fast)' },
//     { value: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro (most capable)' },
//   ],
// };

export default function OAProspectingModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [subTab, setSubTab]       = useState('general');
  const [seedDone, setSeedDone]   = useState(false);
  const [seeding, setSeeding]     = useState(false);
  const [seedMsg, setSeedMsg]     = useState('');

  const [cfg, setCfg]         = useState({
    ai_provider:     'anthropic',
    ai_model:        'claude-haiku-4-5-20251001',
    product_context: '',
  });
  const [orgResearchPrompt, setOrgResearchPrompt] = useState('');
  const [orgDraftPrompt,    setOrgDraftPrompt]    = useState('');
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);
  // Live AI model catalog from GET /org/admin/ai/providers (replaces the old
  // hard-coded ORG_AI_MODELS). Shape: [{ id, label, models: [{ id, label, tier }] }].
  const [aiProviders, setAiProviders] = useState([]);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    Promise.all([
      fetch(`${API}/org/admin/prospecting/ai-config`, { headers }).then(r => r.json()),
      fetch(`${API}/prompts/org/prospecting`, { headers }).then(r => r.json()),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
      // Self-catch so a providers hiccup can't blank the rest of the panel.
      fetch(`${API}/org/admin/ai/providers`, { headers }).then(r => r.json()).catch(() => ({ providers: [] })),
    ]).then(([cfgRes, promptRes, seedRes, provRes]) => {
      const c = cfgRes || {};
      setCfg({
        ai_provider:     c.ai_provider     || 'anthropic',
        ai_model:        c.ai_model        || 'claude-haiku-4-5-20251001',
        product_context: c.product_context || '',
      });
      setOrgResearchPrompt(promptRes?.prompts?.prospecting_research || '');
      setOrgDraftPrompt(promptRes?.prompts?.prospecting_draft       || '');
      setSeedDone(!!seedRes?.status?.prospecting);
      setAiProviders(Array.isArray(provRes?.providers) ? provRes.providers : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleSeedProspecting = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'prospecting' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r1 = await fetch(`${API}/org/admin/prospecting/ai-config`, {
        method: 'PATCH', headers,
        body: JSON.stringify(cfg),
      });
      if (!r1.ok) { const e = await r1.json(); throw new Error(e?.error?.message || 'AI config save failed'); }

      const r2 = await fetch(`${API}/prompts/org/prospecting`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          prompts: { prospecting_research: orgResearchPrompt, prospecting_draft: orgDraftPrompt },
        }),
      });
      if (!r2.ok) { const e = await r2.json(); throw new Error(e?.error?.message || 'Prompts save failed'); }

      showFlash('success', 'Prospecting AI settings saved ✓');
    } catch(err) {
      showFlash('error', err.message || 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  // Provider list from the same live registry (replaces the hard-coded
  // anthropic/openai/gemini options). Preserve the saved provider as a lone
  // option if it's missing from the catalog or the registry hasn't loaded.
  const providerOptions = aiProviders.map(p => ({ value: p.id, label: p.label || p.id }));
  if (cfg.ai_provider && !providerOptions.some(o => o.value === cfg.ai_provider)) {
    providerOptions.unshift({ value: cfg.ai_provider, label: cfg.ai_provider });
  }

  // Models for the currently-selected provider, sourced from the live AI
  // registry instead of a hard-coded list, so newly-released or discovered
  // models appear automatically. If the saved model isn't in the catalog (or
  // the registry hasn't loaded yet), surface it as a lone option so the current
  // selection is never silently dropped.
  const providerEntry  = aiProviders.find(p => p.id === cfg.ai_provider);
  const providerModels = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
  const modelOptions   = providerModels.map(m => ({ value: m.id, label: m.label || m.id }));
  if (cfg.ai_model && !modelOptions.some(o => o.value === cfg.ai_model)) {
    modelOptions.unshift({ value: cfg.ai_model, label: cfg.ai_model });
  }

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🎯 Prospecting</h2>
          <p className="sv-panel-desc">Full prospecting pipeline — prospect lists, outreach stages, ICP scoring, and playbooks.</p>
        </div>
      </div>

      <ModuleSubTabs
        tabs={[['general', 'General'], ['ai', 'AI Settings'], ['skill-inputs', 'Skill inputs'], ['calls', 'Call Settings'], ['twilio', 'Twilio'], ['linkedin-automation', 'LinkedIn'], ['sending-schedule', 'Sending Schedule'], ['escalation', 'Escalation'], ['enrichment', 'Enrichment'], ['playbook', 'Playbook']]}
        active={subTab}
        onChange={setSubTab}

      
      />

      {/* ── General sub-tab ── */}
      {subTab === 'general' && (
        <>
          <OAModuleGeneral
            moduleKey="prospecting"
            icon="🎯"
            label="Prospecting"
            desc="Enables the prospect pipeline, ICP scoring, outreach sequencing, and prospecting playbooks for your whole organisation."
            toggleFn={(enabled) => apiService.prospects.toggleModule(enabled)}
          />
          <OACampaignDeletePolicy />
          <OAManagerEditPolicy />
          <OAProspectVisibilityPolicy />
        </>
      )}

      {/* ── Skill inputs sub-tab ── */}
      {subTab === 'skill-inputs' && <OAProspectingSkillConfig />}

      {/* ── Sending Schedule sub-tab — org-wide send window, pacing, budget
            split. Rendered editable here (admin console); readOnly=false. ── */}
      {subTab === 'sending-schedule' && <OrgSendingScheduleSettings readOnly={false} />}

      {/* ── Playbook seed sub-tab ── */}
      {subTab === 'playbook' && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedProspecting}
          color="#0F9D8E"
          playbookName="GoWarm Prospecting Playbook"
          playbookDesc="42 plays across 9 stages: Target → Research → Outreach → Engaged → RAL → Sales Discovery Call → SAL → Disqualified / Nurture."
        />
      )}

      {/* ── Call Settings sub-tab ── */}
      {subTab === 'calls' && (
        <OACallSettings />
      )}

      {/* ── Twilio sub-tab ── */}
      {subTab === 'twilio' && (
        <OATwilioSettings />
      )}

      {/* ── LinkedIn automation sub-tab — org master toggle + guardrails for
            connection-request auto-send. Per-rep opt-in lives in Settings. ── */}
      {subTab === 'linkedin-automation' && (
        <OALinkedInAutomation />
      )}

      {/* ── Escalation sub-tab ── */}
      {subTab === 'escalation' && (
        <OAProspectingEscalation />
      )}

      {/* ── Enrichment sub-tab ── */}
      {subTab === 'enrichment' && (
        <OAProspectingEnrichment />
      )}

      {/* ── AI Settings sub-tab ── */}
      {subTab === 'ai' && (
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>🤖 Org AI Defaults</h3>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
              Org-wide defaults for prospecting AI. Individual users can override these in My Preferences.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{ padding: '7px 18px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
          >
            {saving ? '⏳ Saving…' : '💾 Save'}
          </button>
        </div>

        {flash && (
          <div style={{
            marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
            background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
            color:      flash.type === 'success' ? '#065f46'  : '#991b1b',
            border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
          }}>
            {flash.msg}
          </div>
        )}

        {loading ? (
          <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* Provider + Model row */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Default AI Provider</label>
                <select
                  value={cfg.ai_provider}
                  onChange={e => setCfg(p => ({ ...p, ai_provider: e.target.value, ai_model: '' }))}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                >
                  {/* Hard-coded provider options REPLACED 2026-06 by the live
                      registry fetch (GET /org/admin/ai/providers). Kept as a
                      breadcrumb in case the endpoint is ever unavailable.
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="gemini">Google (Gemini)</option>
                  */}
                  {providerOptions.length === 0 ? (
                    <option value="">{loading ? 'Loading providers…' : 'No providers available'}</option>
                  ) : (
                    providerOptions.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))
                  )}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Default Model</label>
                <select
                  value={cfg.ai_model}
                  onChange={e => setCfg(p => ({ ...p, ai_model: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                >
                  {modelOptions.length === 0 ? (
                    <option value="">{loading ? 'Loading models…' : 'No models available'}</option>
                  ) : (
                    modelOptions.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {/* Product context */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                What your org sells — AI context
              </label>
              <textarea
                value={cfg.product_context}
                onChange={e => setCfg(p => ({ ...p, product_context: e.target.value }))}
                rows={4}
                placeholder="Describe what your organisation sells and who you sell to. This context is injected into every AI research and drafting prompt.&#10;&#10;e.g. We sell revenue operations software to B2B consulting firms with 50-500 employees. Key pain points we solve: siloed pipeline data, manual reporting, and inconsistent sales processes."
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>

            {/* Org prompt templates */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                Research prompt template
                <span style={{ color: '#9ca3af' }}> — use <code>{'{{prospectInfo}}'}</code> where prospect data should appear.</span>
              </label>
              <textarea
                value={orgResearchPrompt}
                onChange={e => setOrgResearchPrompt(e.target.value)}
                rows={5}
                placeholder="Leave blank to use the system default…"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                Draft email prompt template
                <span style={{ color: '#9ca3af' }}> — use <code>{'{{prospectInfo}}'}</code> and <code>{'{{researchNotes}}'}</code>.</span>
              </label>
              <textarea
                value={orgDraftPrompt}
                onChange={e => setOrgDraftPrompt(e.target.value)}
                rows={5}
                placeholder="Leave blank to use the system default…"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }}
              />
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
