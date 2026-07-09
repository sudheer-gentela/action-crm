/* OATrackingDiagnostics.js — Org Admin panel for open/click tracking (Phase 7).
 *
 * Read-only. Answers, in one screen:
 *   1. Is tracking armed?      (secret, active domain, campaign toggles)
 *   2. Is the pixel added?     (live decorateHtml probe per step log)
 *   3. Opens / clicks landing? (raw events, bot-classified)
 *   4. Do the REPORTS see them? (snapshot freshness — reports read
 *      prospecting_metric_daily, not the events table)
 *
 * Mount in OrgAdminView.js alongside the other panels:
 *   import OATrackingDiagnostics from './orgadmin/panels/OATrackingDiagnostics';
 *   {tab === 'tracking-diag' && <OATrackingDiagnostics />}
 */
import React from 'react';

const OK = '#0a7d3c';
const BAD = '#c0392b';
const WARN = '#b9770e';
const MUTED = '#6b7280';

function Dot({ ok, warn }) {
  const color = warn ? WARN : ok ? OK : BAD;
  return <span style={{ color, fontWeight: 700, marginRight: 6 }}>{warn ? '▲' : ok ? '✔' : '✘'}</span>;
}

function Row({ ok, warn, label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '5px 0', gap: 8 }}>
      <Dot ok={ok} warn={warn} />
      <span style={{ minWidth: 210, fontWeight: 600 }}>{label}</span>
      <span style={{ color: MUTED }}>{children}</span>
    </div>
  );
}

const VERDICT = {
  decorated:        ['Decorated — pixel + links injected at send', OK],
  secret_missing:   ['TRACKING_TOKEN_SECRET / JWT_SECRET not set on this server. signToken throws, decorateHtml swallows it, mail goes out untracked.', BAD],
  no_campaign:      ['Prospect has no campaign_id, so toggles resolve to false. Also means events would bucket to campaign 0 in reports.', BAD],
  toggles_off:      ['Campaign toggles are both OFF (default). Enable under the campaign\'s tracking settings.', BAD],
  no_active_domain: ['No ACTIVE tracking domain for this org. D40: no shared fallback — mail ships untracked.', BAD],
  unknown:          ['Gates look open but decorateHtml returned the original HTML. Check server logs for [EmailTracking].', BAD],
};

export default function OATrackingDiagnostics() {
  const API = process.env.REACT_APP_API_URL;
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = React.useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [summary, setSummary] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [detail, setDetail] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      fetch(`${API}/tracking-diagnostics/summary`, { headers })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('summary ' + r.status)))),
      fetch(`${API}/tracking-diagnostics/step-logs?limit=25`, { headers })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('step-logs ' + r.status)))),
    ])
      .then(([s, l]) => { setSummary(s); setLogs(l.step_logs || []); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [API, headers]);

  React.useEffect(load, [load]);

  function probe(id) {
    setSelected(id);
    setDetail(null);
    setBusy(true);
    fetch(`${API}/tracking-diagnostics/step-log/${id}`, { headers })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('probe ' + r.status))))
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  if (loading) return <div style={{ padding: 20 }}>Loading tracking diagnostics…</div>;
  if (error && !summary) return <div style={{ padding: 20, color: BAD }}>Error: {error}</div>;

  const s = summary;
  const activeDomains = s.domains.filter((d) => d.status === 'active');
  const snapshotStale =
    s.snapshot?.max_d && new Date(s.snapshot.max_d) < new Date(Date.now() - 36 * 3600 * 1000);

  return (
    <div style={{ padding: 20, maxWidth: 1000, fontSize: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Tracking diagnostics</h2>
        <button onClick={load} style={{ padding: '6px 14px', cursor: 'pointer' }}>Refresh</button>
      </div>

      {/* ── 1. Is tracking armed? ─────────────────────────────────────────── */}
      <h3 style={{ marginTop: 24 }}>1. Is tracking armed?</h3>
      <Row ok={s.secret_configured} label="Token secret">
        {s.secret_configured
          ? 'TRACKING_TOKEN_SECRET / JWT_SECRET present'
          : 'MISSING — every send silently goes out untracked'}
      </Row>
      <Row ok={activeDomains.length > 0} warn={s.multi_host_warning} label="Active tracking domain">
        {activeDomains.length === 0
          ? 'none — D40 means no tracking at all, no fallback'
          : activeDomains.map((d) => d.hostname).join(', ')}
        {s.multi_host_warning && (
          <em style={{ color: WARN, display: 'block' }}>
            More than one active host. SequenceStepFirer does not pass senderEmail
            to decorateHtml, so getActiveHostname always returns the lowest-id host —
            links will cross-domain regardless of sender.
          </em>
        )}
      </Row>
      <Row ok={s.campaigns_with_tracking.length > 0} label="Campaigns with tracking on">
        {s.campaigns_with_tracking.length === 0
          ? 'none (toggles default OFF)'
          : s.campaigns_with_tracking
              .map((c) => `${c.id} ${c.name} [${c.tracking_opens ? 'O' : '-'}${c.tracking_clicks ? 'C' : '-'}]`)
              .join(' · ')}
      </Row>

      {/* ── 2. Are events landing? ────────────────────────────────────────── */}
      <h3 style={{ marginTop: 24 }}>2. Are events landing?</h3>
      {s.events_total === 0 ? (
        <Row ok={false} label="Engagement events">
          None, ever. Either nothing has been decorated (see the probe below), or
          the tracking hostname is not reaching this origin.
        </Row>
      ) : (
        <>
          <Row ok={s.events_human > 0} label="Engagement events">
            {s.events_human} human / {s.events_total} total
          </Row>
          <table style={{ borderCollapse: 'collapse', marginTop: 8, marginLeft: 26 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: MUTED }}>
                <th style={{ padding: '4px 16px 4px 0' }}>type</th>
                <th style={{ padding: '4px 16px 4px 0' }}>classification</th>
                <th style={{ padding: '4px 16px 4px 0' }}>count</th>
                <th style={{ padding: '4px 0' }}>latest</th>
              </tr>
            </thead>
            <tbody>
              {s.events.map((e, i) => (
                <tr key={i}>
                  <td style={{ padding: '3px 16px 3px 0' }}>{e.event_type}</td>
                  <td style={{ padding: '3px 16px 3px 0', color: e.is_bot ? WARN : OK }}>
                    {e.is_bot ? `bot (${e.bot_reason})` : 'human'}
                  </td>
                  <td style={{ padding: '3px 16px 3px 0' }}>{e.n}</td>
                  <td style={{ padding: '3px 0', color: MUTED }}>
                    {e.latest ? new Date(e.latest).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ── 3. Do the reports see them? ───────────────────────────────────── */}
      <h3 style={{ marginTop: 24 }}>3. Do the reports see them?</h3>
      <Row ok={!snapshotStale && !!s.snapshot?.max_d} warn={snapshotStale} label="Snapshot (metric_daily)">
        last day: {s.snapshot?.max_d || 'never'} · opens {s.snapshot?.opens ?? 0} · clicks {s.snapshot?.clicks ?? 0} (30d)
        {s.events_human > 0 && (s.snapshot?.opens ?? 0) + (s.snapshot?.clicks ?? 0) === 0 && (
          <em style={{ color: WARN, display: 'block' }}>
            Human events exist but the snapshot has zero. Reports read
            prospecting_metric_daily, not email_engagement_events. Run:{' '}
            <code>node scripts/backfillMetricDaily.js &lt;orgId&gt;</code>
          </em>
        )}
      </Row>

      {/* ── 4. Per-send probe ─────────────────────────────────────────────── */}
      <h3 style={{ marginTop: 24 }}>4. Is the pixel being added? (live probe)</h3>
      <p style={{ color: MUTED, marginTop: 0 }}>
        Decoration is never persisted — the stored body is the pre-decoration text.
        This runs the real gates for a chosen send and reports whether{' '}
        <code>decorateHtml</code> would have injected anything. Nothing is written or sent.
      </p>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <table style={{ borderCollapse: 'collapse', flex: '0 0 auto' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: MUTED }}>
              <th style={{ padding: '4px 12px 4px 0' }}>log</th>
              <th style={{ padding: '4px 12px 4px 0' }}>prospect</th>
              <th style={{ padding: '4px 12px 4px 0' }}>fired</th>
              <th style={{ padding: '4px 12px 4px 0' }}>O/C</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} style={{ background: selected === l.id ? '#f1f5f9' : 'transparent' }}>
                <td style={{ padding: '3px 12px 3px 0' }}>{l.id}</td>
                <td style={{ padding: '3px 12px 3px 0' }}>{l.prospect_email || l.prospect_id}</td>
                <td style={{ padding: '3px 12px 3px 0', color: MUTED }}>
                  {l.fired_at ? new Date(l.fired_at).toLocaleString() : '—'}
                </td>
                <td style={{ padding: '3px 12px 3px 0' }}>
                  {l.opens}/{l.clicks}
                  {l.bot_events > 0 && <span style={{ color: WARN }}> +{l.bot_events}🤖</span>}
                </td>
                <td style={{ padding: '3px 0' }}>
                  <button onClick={() => probe(l.id)} disabled={busy} style={{ cursor: 'pointer' }}>
                    Probe
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {busy && <div style={{ padding: 10 }}>Probing…</div>}

        {detail && !busy && (
          <div style={{ flex: 1, border: '1px solid #e5e7eb', borderRadius: 6, padding: 14 }}>
            <strong>step_log {detail.step_log.id}</strong>
            <div style={{ color: MUTED, marginBottom: 10 }}>
              {detail.step_log.prospect_email} · sender {detail.step_log.sender_email || '(none)'}
            </div>

            <div
              style={{
                padding: 10, borderRadius: 4, marginBottom: 12,
                background: detail.decoration.decorated ? '#ecfdf5' : '#fef2f2',
                color: VERDICT[detail.decoration.verdict]?.[1] || BAD,
              }}
            >
              <strong>{detail.decoration.decorated ? 'DECORATED' : 'UNTRACKED'}</strong>
              <div>{VERDICT[detail.decoration.verdict]?.[0]}</div>
            </div>

            <Row ok={detail.gates.secret_configured} label="secret">
              {detail.gates.secret_configured ? 'present' : 'missing'}
            </Row>
            <Row ok={!!detail.gates.campaign_id} label="campaign">
              {detail.gates.campaign_id
                ? `${detail.gates.campaign_id} — ${detail.gates.campaign_name}`
                : 'none (events would bucket to campaign 0)'}
            </Row>
            <Row ok={detail.gates.tracking_opens || detail.gates.tracking_clicks} label="toggles">
              opens={String(detail.gates.tracking_opens)} clicks={String(detail.gates.tracking_clicks)}
            </Row>
            <Row ok={!!detail.gates.host_actual} warn={detail.gates.host_misalignment} label="tracking host">
              {detail.gates.host_actual || 'none'}
              {detail.gates.host_misalignment &&
                ` — sender aligns with ${detail.gates.host_aligned_with_sender}, but the send path picks ${detail.gates.host_actual}`}
            </Row>
            <Row ok={detail.decoration.pixel_present} label="pixel in probe output">
              {String(detail.decoration.pixel_present)}
            </Row>
            <Row ok={detail.decoration.link_rewritten} label="link rewritten">
              {String(detail.decoration.link_rewritten)}
            </Row>
            {detail.body_shape.clicks_may_have_nothing_to_rewrite && (
              <Row ok={false} warn label="body shape">
                {detail.body_shape.bare_urls} bare URL(s), no anchor hrefs in the stored body —
                confirm plainTextToHtml wraps them in &lt;a&gt; at send time, or clicks can never fire.
              </Row>
            )}

            <h4 style={{ marginBottom: 4 }}>Events ({detail.events.length})</h4>
            {detail.events.length === 0 ? (
              <div style={{ color: MUTED }}>
                None yet. Expected if the recipient hasn&apos;t opened. Only meaningful once the
                probe above says DECORATED.
              </div>
            ) : (
              detail.events.map((e) => (
                <div key={e.id} style={{ color: e.is_bot ? WARN : OK, fontFamily: 'monospace', fontSize: 12 }}>
                  {e.event_type} {e.is_bot ? `bot(${e.bot_reason})` : 'human'} ·{' '}
                  {new Date(e.occurred_at).toLocaleString()} · {e.user_agent || '(no UA)'}
                </div>
              ))
            )}

            {detail.decoration.decorated && detail.step_log.sender_email && (
              <div style={{ marginTop: 12, color: MUTED }}>
                Ground truth: open <strong>{detail.step_log.sender_email}</strong> → Sent →
                message to {detail.step_log.prospect_email} → View original → search for{' '}
                <code>{detail.gates.host_actual}</code>.
              </div>
            )}
          </div>
        )}
      </div>

      {error && <div style={{ marginTop: 16, color: BAD }}>Error: {error}</div>}
    </div>
  );
}
