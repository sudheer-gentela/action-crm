// ────────────────────────────────────────────────────────────────────────────
// TrackingSettings.js — Phase 7 of the Outbound Insights & WBR system
// (docs/INSIGHTS_WBR_DESIGN.md)
//
// Two exports, both self-contained (inline styles matching the teal/slate
// system — no CSS file to wire):
//
//   <TrackingDomainSettings />
//     Org-level card for the per-customer CNAME tracking domain. Drop into
//     the org settings / admin area. Shows: current domains with status,
//     add-hostname input, the exact CNAME record to copy, and a Verify
//     button driving DNS check → certificate issuance → active.
//
//   <CampaignTrackingToggles campaignId={id} />
//     Two checkboxes (opens / clicks, DEFAULT OFF — D39) for the Tracking
//     tab of CampaignConfigScreen. SELF-CONTAINED: loads and saves through
//     GET/PUT /api/tracking-domains/campaign/:id/toggles (dedicated columns
//     — the config-override jsonb is replace-on-save and would wipe a
//     tracking key, see D39 amendment). Shows an inline notice when the org
//     has no active tracking domain (D40 — toggles are inert until one
//     exists), and surfaces the 403 message for non-owners.
// ────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const S = {
  card: { border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, background: '#fff', maxWidth: 640 },
  title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 4 },
  sub: { fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginBottom: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  input: { flex: 1, border: '1px solid #d1d5db', borderRadius: 7, padding: '7px 10px', fontSize: 13 },
  btn: { border: '1px solid #0F9D8E', background: '#fff', color: '#0f766e', borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer' },
  btnPrimary: { border: '1px solid #0F9D8E', background: '#0F9D8E', color: '#fff', borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer' },
  code: { display: 'block', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: '8px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#0f172a', margin: '6px 0' },
  chip: (bg, fg) => ({ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', padding: '2px 8px', borderRadius: 999, background: bg, color: fg }),
  err: { fontSize: 12, color: '#b91c1c', marginTop: 4, lineHeight: 1.5 },
  note: { fontSize: 12, color: '#92400e', background: '#fef3c7', borderRadius: 7, padding: '8px 10px', lineHeight: 1.5 },
};

const STATUS_CHIP = {
  active: ['#dcfce7', '#166534'],
  verifying: ['#e0f2f1', '#0f766e'],
  pending: ['#f1f5f9', '#475569'],
  failed: ['#fee2e2', '#991b1b'],
  disabled: ['#f1f5f9', '#94a3b8'],
};

export function TrackingDomainSettings() {
  const [domains, setDomains] = useState(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    apiFetch('/tracking-domains').then((r) => setDomains(r.domains || [])).catch(() => setDomains([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = () => {
    setBusy(true); setError(null);
    apiFetch('/tracking-domains', { method: 'POST', body: JSON.stringify({ hostname }) })
      .then(() => { setHostname(''); load(); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const verify = (id) => {
    setBusy(true); setError(null);
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Verification is taking longer than expected — the check continues in the background; click Verify again in a minute.')), 30000));
    Promise.race([
      apiFetch(`/tracking-domains/${id}/verify`, { method: 'POST' }).then(load),
      timeout,
    ]).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  return (
    <div style={S.card}>
      <div style={S.title}>Email tracking domain</div>
      <div style={S.sub}>
        Open and click tracking requires a tracking subdomain on <b>your</b> company
        domain — it keeps tracked links aligned with your sending domain and your
        deliverability isolated. One DNS record, then Verify.
      </div>

      {domains === null ? (
        <div style={S.sub}>Loading…</div>
      ) : domains.filter((d) => d.status !== 'disabled').map((d) => (
        <div key={d.id} style={{ marginBottom: 12 }}>
          <div style={S.row}>
            <span style={{ fontWeight: 500, fontSize: 13 }}>{d.hostname}</span>
            <span style={S.chip(...(STATUS_CHIP[d.status] || STATUS_CHIP.pending))}>{d.status}</span>
            {d.status !== 'active' && (
              <button style={S.btn} disabled={busy} onClick={() => verify(d.id)}>Verify</button>
            )}
            <button
              style={{ ...S.btn, borderColor: '#fca5a5', color: '#b91c1c' }}
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Remove ${d.hostname}? ${d.status === 'active' ? 'Email tracking will stop for all campaigns until a new domain is verified.' : 'You can re-add it any time.'}`)) return;
                setBusy(true); setError(null);
                apiFetch(`/tracking-domains/${d.id}`, { method: 'DELETE' })
                  .then(load).catch((e) => setError(e.message)).finally(() => setBusy(false));
              }}
            >
              Remove
            </button>
          </div>
          {d.status !== 'active' && d.instructions && (
            <>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Add this record at your DNS provider:</div>
              <code style={S.code}>{d.instructions.record_type}&nbsp;&nbsp;{d.instructions.host}&nbsp;&nbsp;→&nbsp;&nbsp;{d.instructions.target}</code>
            </>
          )}
          {d.error_message && <div style={S.err}>{d.error_message}</div>}
        </div>
      ))}

      {domains !== null && !domains.some((d) => d.status === 'active') && (
        <div style={S.row}>
          <input
            style={S.input}
            placeholder="t.yourcompany.com"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
          />
          <button style={S.btnPrimary} disabled={busy || !hostname} onClick={add}>Add domain</button>
        </div>
      )}
      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}

export function CampaignTrackingToggles({ campaignId }) {
  const [hasActiveDomain, setHasActiveDomain] = useState(null);
  const [toggles, setToggles] = useState(null);
  const [canWrite, setCanWrite] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    apiFetch('/tracking-domains')
      .then((r) => setHasActiveDomain((r.domains || []).some((d) => d.status === 'active')))
      .catch(() => setHasActiveDomain(false));
    apiFetch(`/tracking-domains/campaign/${campaignId}/toggles`)
      .then((r) => {
        setToggles({ opens: r.opens === true, clicks: r.clicks === true });
        setCanWrite(r.can_write === true);
      })
      .catch(() => { setToggles({ opens: false, clicks: false }); setCanWrite(false); });
  }, [campaignId]);

  const set = (key, on) => {
    const prev = toggles;
    const next = { ...(toggles || {}), [key]: on };
    setToggles(next);
    setSaving(true); setError(null);
    apiFetch(`/tracking-domains/campaign/${campaignId}/toggles`, {
      method: 'PUT', body: JSON.stringify(next),
    })
      .then((saved) => {
        setToggles({ opens: saved.opens === true, clicks: saved.clicks === true });
        if (typeof saved.can_write === 'boolean') setCanWrite(saved.can_write);
        setFlash('Saved'); setTimeout(() => setFlash(null), 2000);
      })
      .catch((e) => { setError(e.message); setToggles(prev); })
      .finally(() => setSaving(false));
  };

  const noDomain = hasActiveDomain === false;
  const noPerm   = canWrite === false;
  const disabled = noDomain || noPerm || toggles === null;
  const t = toggles || {};

  return (
    <div style={S.card}>
      <div style={S.title}>Engagement tracking</div>
      <div style={S.sub}>
        Off by default. Tracking modifies email HTML and can affect deliverability
        on cold outreach — replies remain the most reliable engagement signal.
        Opens are <b>directional</b> (Apple Mail Privacy inflates them).
        Changes apply to emails sent after the change; in-flight scheduled
        sends pick it up at send time.
      </div>
      {noDomain && (
        <div style={{ ...S.note, marginBottom: 10 }}>
          Set up a verified tracking domain in Org Admin → Tracking Domain first —
          tracking stays off until one is active.
        </div>
      )}
      {!noDomain && noPerm && (
        <div style={{ ...S.note, marginBottom: 10 }}>
          Only the campaign owner, their manager, or an org admin can change
          tracking for this campaign.
        </div>
      )}
      <label style={{ ...S.row, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
        <input type="checkbox" checked={t.clicks === true} disabled={disabled || saving}
               onChange={(e) => set('clicks', e.target.checked)} />
        <span style={{ fontSize: 13 }}>Track link clicks</span>
      </label>
      <label style={{ ...S.row, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
        <input type="checkbox" checked={t.opens === true} disabled={disabled || saving}
               onChange={(e) => set('opens', e.target.checked)} />
        <span style={{ fontSize: 13 }}>Track opens (directional)</span>
      </label>
      {flash && <div style={{ fontSize: 12, color: '#0f766e' }}>{flash}</div>}
      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}

export default TrackingDomainSettings;
