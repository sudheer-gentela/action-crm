// CampaignReplyStopToggle — the 2026_50 per-campaign toggle.
//
// Self-contained: talks to the dedicated /linkedin-connections/
// reply-stop-settings endpoints rather than the campaign UPDATE route (that
// route's fixed-column partial update is under active parallel development —
// widening it from a snapshot risks clobbering newer fields).
//
// Two mounting modes:
//   <CampaignReplyStopToggle campaignId={id} />  — single-campaign row for
//     embedding inside CampaignConfigScreen / CampaignConfigPanel.
//   <CampaignReplyStopToggle />                  — all-campaigns settings list
//     (org settings surface), one row per campaign.
//
// Default is ON (stop on reply) — the checkbox represents the OPT-OUT, so the
// copy is phrased around what turning it OFF means. NULL/legacy rows read as
// true, matching the firer's `!== false` guard.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

export default function CampaignReplyStopToggle({ campaignId = null }) {
  const [campaigns, setCampaigns] = useState(null);
  const [error, setError]         = useState(null);
  const [savingId, setSavingId]   = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/linkedin-connections/reply-stop-settings');
      let list = res.campaigns || [];
      if (campaignId != null) list = list.filter(c => c.id === Number(campaignId));
      setCampaigns(list);
    } catch (err) {
      setError(err.message || 'Failed to load reply-stop settings');
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (c) => {
    const next = !(c.stopOnReply !== false);   // NULL/legacy → currently true
    setSavingId(c.id);
    try {
      await apiFetch('/linkedin-connections/reply-stop-settings', {
        method: 'PUT',
        body: JSON.stringify({ campaignId: c.id, stopOnReply: next }),
      });
      setCampaigns(prev => prev.map(x => x.id === c.id ? { ...x, stopOnReply: next } : x));
    } catch (err) {
      setError('Save failed: ' + (err.message || 'unknown'));
    } finally {
      setSavingId(null);
    }
  };

  // v2: ALWAYS render as a visible card, including error/empty states — an
  // invisible failure under a tall config panel is indistinguishable from
  // "not deployed" (which is exactly what happened in UAT).
  const card = (body) => (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
                  padding: '12px 14px' }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.03em', color: '#6b7280', marginBottom: 6 }}>
        Stop sequences on reply
      </div>
      {body}
    </div>
  );

  if (error) return card(
    <div style={{ color: '#b91c1c', fontSize: 13 }}>
      {error}
      {/not found|404/i.test(error) &&
        ' — the reply-stop endpoints are missing; deploy the latest linkedin-connections.routes.js.'}
    </div>
  );
  if (!campaigns) return card(<div style={{ color: '#6b7280', fontSize: 13 }}>Loading…</div>);
  if (!campaigns.length) return card(
    <div style={{ color: '#6b7280', fontSize: 13 }}>
      {campaignId != null
        ? 'This campaign was not found in reply-stop settings.'
        : 'No campaigns yet.'}
    </div>
  );

  return card(
    <div>
      {campaigns.map(c => {
        const on = c.stopOnReply !== false;
        return (
          <label key={c.id}
                 style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
                          padding: '6px 0', cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <input type="checkbox" checked={on} disabled={savingId === c.id}
                   onChange={() => toggle(c)} style={{ marginTop: 2 }} />
            <span>
              {campaignId == null && <strong>{c.name}</strong>}
              {campaignId == null && ' — '}
              Stop active sequence enrollments when the prospect replies
              (email or LinkedIn).
              {!on && (
                <span style={{ color: '#b45309' }}>
                  {' '}Currently OFF — replying prospects will keep receiving steps.
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
