// ProspectActivityDrawer — the "click a person, see their story" drawer.
//
// Extracted from LinkedInFunnelPanel (P5b) so the same drawer serves two
// hosts with different authorization scopes:
//
//   * LinkedIn funnel tab (TeamReportingView) — fetchPath points at the
//     owner-scoped /linkedin-connections/funnel/:prospectId. Unchanged look
//     and behavior from the pre-extraction drawer.
//   * Campaign drawer (CampaignsView) — fetchPath points at the campaign-
//     scoped /prospecting-campaigns/:id/prospect-activity/:prospectId, which
//     authorizes via CampaignAccess (owner / manager / admin) instead of
//     owner_id, so a manager viewing a rep's campaign can open prospects
//     they don't own. Passing emailEngagementPath additionally renders an
//     "Email ledger" section (per-send delivery verdict + opens/clicks) —
//     the campaign context is multichannel, the funnel tab is not.
//
// The payload contract is identical for both hosts:
//   { prospect: {...lifecycle fields}, messages: [...], activities: [...] }
//
// Styling reuses the namespaced lifp-* classes from LinkedInFunnelPanel.css —
// one stylesheet, one look, wherever the drawer opens.

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';
import './LinkedInFunnelPanel.css';

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return '—';
  const dDays = Math.floor(diff / 86400000);
  if (dDays < 1)  return 'today';
  if (dDays === 1) return '1d ago';
  if (dDays < 30) return `${dDays}d ago`;
  return fmtDate(iso);
}

function urlHost(u) {
  try { return new URL(u).hostname; } catch (_) { return u; }
}

export default function ProspectActivityDrawer({ fetchPath, emailEngagementPath = null, emailRepliesPath = null, inboxHref = null, onClose }) {
  const [detail, setDetail]       = useState({ loading: true });
  const [actFilter, setActFilter] = useState('all');   // all | linkedin | sequence | call | system
  // null = loading/not requested; [] = loaded, none. The email ledger section
  // renders only when there is something to show — the funnel-tab host never
  // passes emailEngagementPath and never carries the section.
  const [emailSends, setEmailSends] = useState(null);
  // Inbound email replies (real content — unlike LinkedIn, email bodies are
  // stored). null = not requested; [] = none. Only fetched when the campaign
  // host passes emailRepliesPath.
  const [emailReplies, setEmailReplies] = useState(null);
  // Which reply rows are expanded to full text (by reply id).
  const [expandedReplies, setExpandedReplies] = useState({});

  useEffect(() => {
    let cancelled = false;
    setDetail({ loading: true });
    setActFilter('all');
    (async () => {
      try {
        const res = await apiFetch(fetchPath);
        if (!cancelled) setDetail(res);
      } catch (err) {
        if (!cancelled) setDetail({ error: err.message || 'Failed to load prospect detail' });
      }
    })();
    return () => { cancelled = true; };
  }, [fetchPath]);

  useEffect(() => {
    if (!emailEngagementPath) { setEmailSends(null); return; }
    let cancelled = false;
    setEmailSends(null);
    (async () => {
      try {
        const r = await apiFetch(emailEngagementPath);
        if (!cancelled) setEmailSends(r.sends || []);
      } catch (_) {
        // Non-fatal: the section simply doesn't render.
        if (!cancelled) setEmailSends([]);
      }
    })();
    return () => { cancelled = true; };
  }, [emailEngagementPath]);

  useEffect(() => {
    if (!emailRepliesPath) { setEmailReplies(null); return; }
    let cancelled = false;
    setEmailReplies(null);
    setExpandedReplies({});
    (async () => {
      try {
        const r = await apiFetch(emailRepliesPath);
        if (!cancelled) setEmailReplies(r.replies || []);
      } catch (_) {
        if (!cancelled) setEmailReplies([]);
      }
    })();
    return () => { cancelled = true; };
  }, [emailRepliesPath]);

  return (
    <div className="lifp-drawer-backdrop" onClick={onClose}>
      <div className="lifp-drawer" onClick={e => e.stopPropagation()}>
        <button className="lifp-drawer-close" onClick={onClose}>×</button>
        {detail.loading && <div className="lifp-status">Loading…</div>}
        {detail.error && <div className="lifp-status lifp-error">{detail.error}</div>}
        {detail.prospect && (
          <>
            <div className="lifp-drawer-head">
              <div>
                <div className="lifp-drawer-name">{detail.prospect.name}</div>
                <div className="lifp-drawer-company">{detail.prospect.company || ''}</div>
              </div>
              <div className="lifp-drawer-links">
                {detail.prospect.linkedinUrl && (
                  <a href={detail.prospect.linkedinUrl} target="_blank" rel="noopener noreferrer"
                     className="lifp-btn">LinkedIn profile ↗</a>
                )}
                {(() => {
                  const t = (detail.messages || []).find(m => m.threadUrn);
                  return t ? (
                    <a href={'https://www.linkedin.com/messaging/thread/' +
                             t.threadUrn.replace('urn:li:messagingThread:', '') + '/'}
                       target="_blank" rel="noopener noreferrer" className="lifp-btn">Conversation ↗</a>
                  ) : null;
                })()}
              </div>
            </div>

            {(() => {
              const threadUrn = (detail.messages || []).map(m => m.threadUrn).find(Boolean);
              const threadUrl = threadUrn
                ? 'https://www.linkedin.com/messaging/thread/' + threadUrn.replace('urn:li:messagingThread:', '') + '/'
                : null;
              const Count = ({ label, value }) => (
                threadUrl
                  ? <a className="lifp-fact-link" href={threadUrl} target="_blank" rel="noopener noreferrer" title="Open conversation in LinkedIn">
                      <span>{label} ↗</span>{value}
                    </a>
                  : <div><span>{label}</span>{value}</div>
              );
              return (
                <div className="lifp-drawer-facts">
                  <div><span>Requested</span>{fmtDate(detail.prospect.requestSentAt)}</div>
                  <div><span>Accepted</span>{fmtDate(detail.prospect.connectedAt)}</div>
                  <div><span>Verified</span>{detail.prospect.verifiedAt ? relTime(detail.prospect.verifiedAt) : '—'}</div>
                  <div><span>Status</span>{detail.prospect.liStatus || '—'}</div>
                  <Count label="Messages" value={detail.prospect.messageCount} />
                  <Count label="Replies" value={detail.prospect.replyCount} />
                </div>
              );
            })()}

            <div className="lifp-drawer-section">Message ledger</div>
            {(detail.messages || []).length === 0 && (
              <div className="lifp-drawer-empty">No messages recorded — open the conversation in LinkedIn and click Sync in the extension.</div>
            )}
            {(() => {
              const threadUrn = (detail.messages || []).map(m => m.threadUrn).find(Boolean);
              const threadUrl = threadUrn
                ? 'https://www.linkedin.com/messaging/thread/' + threadUrn.replace('urn:li:messagingThread:', '') + '/'
                : null;
              const RowTag = threadUrl ? 'a' : 'div';
              return (detail.messages || []).map((m, i) => (
                <RowTag key={i} className={'lifp-msg-row' + (threadUrl ? ' lifp-msg-row-link' : '')}
                  {...(threadUrl ? { href: threadUrl, target: '_blank', rel: 'noopener noreferrer' } : {})}>
                  <span className="lifp-act-date" title={m.occurredAt}>{fmtDate(m.occurredAt)}</span>
                  <span className={'lifp-msg-dir ' + (m.direction === 'inbound' ? 'lifp-in' : 'lifp-out')}>
                    {m.direction === 'inbound' ? '← reply' : '→ sent'}
                  </span>
                  {!m.counted && <span className="lifp-msg-uncounted" title="Pre-acceptance (e.g. connection-request note) — recorded but not counted">not counted</span>}
                  {threadUrl && <span className="lifp-msg-open">open ↗</span>}
                </RowTag>
              ));
            })()}
            <div className="lifp-drawer-note">
              Message text is never stored — GoWarm records who messaged whom and when. Open the conversation for content.
            </div>

            {/* Email ledger — campaign-host only (emailEngagementPath set).
                One row per sequence email with its delivery verdict + human
                opens/clicks. Opens are directional; the footnote says so. */}
            {emailSends != null && emailSends.length > 0 && (
              <>
                <div className="lifp-drawer-section">Email ledger</div>
                {emailSends.map(send => {
                  const verdict =
                    send.verdict === 'hard_bounce'   ? { text: 'bounced',     color: '#b91c1c' }
                    : send.verdict === 'block'       ? { text: 'blocked',     color: '#b45309' }
                    : send.verdict === 'soft_bounce' ? { text: 'soft bounce', color: '#b45309' }
                    : null;   // delivered — say nothing, engagement is the story
                  const parts = [];
                  if (verdict) parts.push(<span key="v" style={{ color: verdict.color, fontWeight: 600 }}>{verdict.text}</span>);
                  if (send.opens > 0) parts.push(<span key="o">{`opened ${send.opens}×${send.lastOpenAt ? ` · last ${fmtDate(send.lastOpenAt)}` : ''}`}</span>);
                  if (send.clicks > 0) {
                    const hosts = [...new Set((send.clickedUrls || []).map(urlHost))].slice(0, 2).join(', ');
                    parts.push(<span key="c" style={{ color: '#6d28d9', fontWeight: 600 }}>{`clicked${hosts ? ` ${hosts}` : ''}`}</span>);
                  }
                  if (parts.length === 0) parts.push(<span key="d" style={{ color: '#9ca3af' }}>no engagement</span>);
                  return (
                    <div key={send.stepLogId} className="lifp-act-row">
                      <span className="lifp-act-date" title={send.firedAt}>{fmtDate(send.firedAt)}</span>
                      <span className="lifp-act-desc">
                        <span style={{ fontWeight: 500 }}>{send.subject}</span>
                        {' — '}
                        {parts.map((p, i) => <React.Fragment key={i}>{i > 0 && ' · '}{p}</React.Fragment>)}
                      </span>
                    </div>
                  );
                })}
                <div className="lifp-drawer-note">
                  Opens are directional — mail-client image proxies can auto-load tracking pixels. Sequence emails only.
                </div>
              </>
            )}

            {/* Email replies — inbound messages with real content (email
                bodies are stored, unlike LinkedIn). Preview collapses the
                quoted history; expand shows the full text. "Open in inbox"
                opens a new tab so this drawer is not lost. */}
            {emailReplies != null && emailReplies.length > 0 && (
              <>
                <div className="lifp-drawer-section">
                  Email replies
                  {inboxHref && (
                    <a href={inboxHref} target="_blank" rel="noopener noreferrer"
                       className="lifp-fact-link" style={{ float: 'right', fontWeight: 500 }}
                       title="Open the inbox in a new tab">
                      Open in inbox ↗
                    </a>
                  )}
                </div>
                {emailReplies.map(rep => {
                  const expanded = !!expandedReplies[rep.id];
                  return (
                    <div key={rep.id} className="lifp-act-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 600, fontSize: 12, color: '#16a34a' }}>
                          ← {rep.subject}
                        </span>
                        <span className="lifp-act-date" style={{ flexShrink: 0 }} title={rep.receivedAt}>
                          {fmtDate(rep.receivedAt)}
                        </span>
                      </div>
                      {rep.fromAddress && (
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{rep.fromAddress}</div>
                      )}
                      <div style={{ fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                        {expanded ? rep.fullText : rep.preview}
                      </div>
                      {rep.truncated && (
                        <button
                          onClick={() => setExpandedReplies(prev => ({ ...prev, [rep.id]: !expanded }))}
                          style={{
                            alignSelf: 'flex-start', background: 'none', border: 'none',
                            color: '#0F766E', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            padding: '2px 0',
                          }}>
                          {expanded ? 'Show less' : 'Show full reply'}
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className="lifp-drawer-note">
                  Reply text shown as received; quoted history is collapsed in the preview.
                  Open the inbox for the full formatted thread.
                </div>
              </>
            )}

            <div className="lifp-drawer-section">Activity</div>
            {(() => {
              const acts = detail.activities || [];
              const kindOf = (a) => {
                const s = (a.source || '') + ' ' + (a.event || '');
                const d = (a.description || '').toLowerCase();
                if (/linkedin|connection|member_urn|reply_received|message_sent/.test(s + ' ' + d)) return 'linkedin';
                if (/call/.test(d)) return 'call';
                if (/sequence|step|auto-send|draft|queued|approved/.test(d)) return 'sequence';
                return 'system';
              };
              const counts = { all: acts.length, linkedin: 0, sequence: 0, call: 0, system: 0 };
              acts.forEach(a => { counts[kindOf(a)]++; });
              const TABS = [
                ['all', 'All'], ['linkedin', 'LinkedIn'], ['sequence', 'Sequence'],
                ['call', 'Call'], ['system', 'System'],
              ];
              const shown = actFilter === 'all' ? acts : acts.filter(a => kindOf(a) === actFilter);
              return (
                <>
                  <div className="lifp-act-filterbar">
                    {TABS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, label]) => (
                      <button key={k}
                        className={'lifp-act-tab' + (actFilter === k ? ' lifp-act-tab-on' : '')}
                        onClick={() => setActFilter(k)}>
                        {label} <span className="lifp-act-count">{counts[k]}</span>
                      </button>
                    ))}
                  </div>
                  {shown.length === 0 && <div className="lifp-drawer-empty">No {actFilter} activity.</div>}
                  {shown.map((a, i) => (
                    <div key={i} className="lifp-act-row">
                      <span className="lifp-act-date">{fmtDate(a.createdAt)}</span>
                      <span className="lifp-act-desc">{a.description}</span>
                    </div>
                  ))}
                </>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
