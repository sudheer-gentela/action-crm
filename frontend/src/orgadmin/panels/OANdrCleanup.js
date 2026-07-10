/* OANdrCleanup.js — Org Admin panel: repair bounces mis-ingested as replies.
 *
 * Calls routes/ndr-cleanup.routes.js, which wraps services/NdrCleanupService —
 * the same code path scripts/cleanupNdrReplies.js uses. The UI and the CLI can
 * therefore never disagree about what "cleanup" means.
 *
 * FLOW
 *   1. Preview (dry run) — the server actually performs every mutation inside a
 *      transaction and ROLLBACKs. What you see is what an apply would do, not a
 *      simulation of it.
 *   2. Apply — same code path, COMMIT. Requires typing CLEANUP.
 *
 * "Parse bounce bodies" (reprocess) additionally writes the
 * email_delivery_events + bounce_received activity that should have existed all
 * along. It surfaces the TRUE failed recipient, which is frequently a different
 * prospect from the one the NDR was attached to — the old inbox sync matched on
 * sending domain, which picks an arbitrary colleague of whoever actually
 * bounced. Leave it on.
 *
 * Mount in OrgAdminView.js alongside the other panels:
 *   import OANdrCleanup from './orgadmin/panels/OANdrCleanup';
 *   {tab === 'ndr-cleanup' && <OANdrCleanup />}
 */
import React from 'react';

const OK = '#0a7d3c';
const BAD = '#c0392b';
const WARN = '#b9770e';
const MUTED = '#6b7280';

const EVENT_COLOR = { hard_bounce: BAD, block: BAD, soft_bounce: WARN };

function Stat({ label, value, tone }) {
  return (
    <div
      style={{
        flex: '1 1 130px',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: '10px 12px',
        background: '#fff',
      }}
    >
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone || '#111827' }}>{value}</div>
    </div>
  );
}

export default function OANdrCleanup() {
  const API = process.env.REACT_APP_API_URL;
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = React.useMemo(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token]
  );

  const [reprocess, setReprocess] = React.useState(true);
  const [preview, setPreview] = React.useState(null);
  const [applied, setApplied] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [confirmText, setConfirmText] = React.useState('');

  function runPreview() {
    setLoading(true);
    setError('');
    setApplied(null);
    setConfirmText('');
    fetch(`${API}/ndr-cleanup/preview?reprocess=${reprocess ? 1 : 0}`, { headers })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b?.error?.message || `preview ${r.status}`)))))
      .then(setPreview)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  function runApply() {
    if (confirmText !== 'CLEANUP') return;
    setBusy(true);
    setError('');
    fetch(`${API}/ndr-cleanup/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirm: 'CLEANUP', reprocess }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b?.error?.message || `apply ${r.status}`)))))
      .then((res) => {
        setApplied(res);
        setPreview(null);
        setConfirmText('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  const result = applied || preview;
  const stats = result?.stats;
  const nothingToDo = result && stats.ndrEmails === 0;

  return (
    <div style={{ maxWidth: 1080 }}>
      <p style={{ color: MUTED, marginTop: 0 }}>
        Undeliverable ("bounce") messages were being stored as prospect replies: they inflated
        reply counts and advanced dead addresses from <strong>outreach</strong> to{' '}
        <strong>engaged</strong>. This finds them, removes the phantom reply, reverts the stage,
        and — with parsing on — records the bounce where it belongs.
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '12px 0',
          borderTop: '1px solid #e5e7eb',
          borderBottom: '1px solid #e5e7eb',
          margin: '12px 0 16px',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={reprocess}
            onChange={(e) => setReprocess(e.target.checked)}
          />
          <span>Parse bounce bodies (writes delivery events)</span>
        </label>

        <button onClick={runPreview} disabled={loading || busy} style={{ padding: '7px 14px' }}>
          {loading ? 'Previewing…' : 'Preview (dry run)'}
        </button>

        {result?.isSuperAdmin && (
          <span style={{ color: WARN, fontSize: 12, fontWeight: 600 }}>
            ▲ super admin — acting on org {result.orgId}
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: BAD, marginBottom: 12 }}>
          ✘ {error}
        </div>
      )}

      {applied && (
        <div
          style={{
            background: '#ecfdf3',
            border: `1px solid ${OK}`,
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 16,
            color: OK,
            fontWeight: 600,
          }}
        >
          ✔ Applied and committed. Re-run <code>backfillMetricDaily.js</code> if you use the WBR
          grid.
        </div>
      )}

      {nothingToDo && (
        <div style={{ color: OK, fontWeight: 600 }}>
          ✔ No bounces are being counted as replies. Nothing to clean.
        </div>
      )}

      {result && stats.ndrEmails > 0 && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
            <Stat label="Bounces found" value={stats.ndrEmails} tone={BAD} />
            <Stat label="Delivery events" value={stats.reprocessed} />
            <Stat label="Phantom replies removed" value={stats.activitiesDeleted} />
            <Stat label="Stages reverted" value={stats.stagesReverted} />
            <Stat label="Action outcomes reset" value={stats.actionsReset} />
          </div>

          {!applied && (
            <div
              style={{
                border: `1px solid ${WARN}`,
                background: '#fffbeb',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 20,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                ▲ Nothing has changed yet — this was a dry run.
              </div>
              <div style={{ color: MUTED, fontSize: 13, marginBottom: 10 }}>
                Reverted prospects get <code>stage_changed_at = now()</code>. The original value
                was overwritten by the bounce and cannot be recovered. The stage itself is exact.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>
                  Type <code>CLEANUP</code> to confirm:
                </span>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="CLEANUP"
                  style={{ padding: '5px 8px', width: 130 }}
                />
                <button
                  onClick={runApply}
                  disabled={confirmText !== 'CLEANUP' || busy}
                  style={{
                    padding: '7px 14px',
                    background: confirmText === 'CLEANUP' ? BAD : '#e5e7eb',
                    color: confirmText === 'CLEANUP' ? '#fff' : MUTED,
                    border: 'none',
                    borderRadius: 6,
                    cursor: confirmText === 'CLEANUP' ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                  }}
                >
                  {busy ? 'Applying…' : 'Apply cleanup'}
                </button>
              </div>
            </div>
          )}

          <h4 style={{ marginBottom: 6 }}>Bounces stored as replies ({result.emails.length})</h4>
          <div style={{ overflowX: 'auto', marginBottom: 24 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ padding: '6px 8px' }}>From</th>
                  <th style={{ padding: '6px 8px' }}>Subject</th>
                  <th style={{ padding: '6px 8px' }}>Attached to</th>
                  <th style={{ padding: '6px 8px' }}>Actually bounced</th>
                  <th style={{ padding: '6px 8px' }}>Type</th>
                </tr>
              </thead>
              <tbody>
                {result.emails.map((e) => {
                  const mismatch =
                    e.parsed?.failedRecipient &&
                    e.parsed.failedRecipient.toLowerCase() !==
                      String(e.prospectEmail || '').toLowerCase();
                  return (
                    <tr key={e.emailId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '6px 8px', color: MUTED }}>{e.fromAddress}</td>
                      <td style={{ padding: '6px 8px' }}>{String(e.subject || '').slice(0, 60)}</td>
                      <td style={{ padding: '6px 8px' }}>{e.prospectEmail}</td>
                      <td style={{ padding: '6px 8px', color: mismatch ? BAD : MUTED }}>
                        {e.parsed?.failedRecipient || (reprocess ? '— unparseable' : '— not parsed')}
                        {mismatch && (
                          <span style={{ fontSize: 11, marginLeft: 6 }}>(wrong prospect)</span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: '6px 8px',
                          fontWeight: 600,
                          color: EVENT_COLOR[e.parsed?.eventType] || MUTED,
                        }}
                      >
                        {e.parsed?.eventType || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginBottom: 6 }}>Prospects affected ({result.prospects.length})</h4>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ padding: '6px 8px' }}>Prospect</th>
                  <th style={{ padding: '6px 8px' }}>Outcome</th>
                  <th style={{ padding: '6px 8px' }}>Why</th>
                </tr>
              </thead>
              <tbody>
                {result.prospects.map((p) => (
                  <tr key={p.prospectId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '6px 8px' }}>{p.prospectEmail}</td>
                    <td
                      style={{
                        padding: '6px 8px',
                        fontWeight: 600,
                        color: p.outcome === 'reverted' ? WARN : OK,
                      }}
                    >
                      {p.outcome === 'reverted' ? 'Stage reverted' : 'Left alone'}
                    </td>
                    <td style={{ padding: '6px 8px', color: MUTED }}>{p.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
