// DraftCard.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import LinkedInDataDrawer from '../LinkedInDataDrawer';
import PersonalizeProvenanceFooter from '../PersonalizeProvenanceFooter';

function DraftCard({ draft, subject, body, isOpen, sending, sendError, onToggle, onSubjectChange, onBodyChange, onSend, onComplete, onDiscard, onConvertAndSend, compact = false, onDrawerToggle }) {
  const overdue  = draft.isOverdue || (draft.scheduledSendAt && new Date(draft.scheduledSendAt) < new Date());
  const channel  = draft.channel || 'email';
  const isEmail  = channel === 'email';

  // ── Personalize drawer state ────────────────────────────────────────────────
  // Local to the card; bubble up via onDrawerToggle so the parent panel can
  // widen to accommodate the drawer. Only relevant when the card is itself
  // expanded (isOpen) — collapsing the card auto-closes the drawer.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const bodyRef = useRef(null);

  const linkedinUrl = draft.prospect?.linkedinUrl || draft.prospect?.linkedin_url || null;

  useEffect(() => {
    // Close drawer + tell parent when the card collapses.
    if (!isOpen && drawerOpen) {
      setDrawerOpen(false);
      if (onDrawerToggle) onDrawerToggle(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen(prev => {
      const next = !prev;
      if (onDrawerToggle) onDrawerToggle(next);
      return next;
    });
  }, [onDrawerToggle]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    if (onDrawerToggle) onDrawerToggle(false);
  }, [onDrawerToggle]);

  // Insert snippet at cursor position in the body textarea, or append if not
  // focused. Always inserts on its own line (or pair of lines) for readability.
  const handleInsertSnippet = useCallback((snippet) => {
    if (!snippet) return;
    const ta = bodyRef.current;
    const cur = body || '';
    const text = snippet.trim();
    if (!ta || ta !== document.activeElement) {
      // No focus → append with a blank line separator.
      const sep = cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : '';
      onBodyChange(cur + sep + text);
      return;
    }
    const start = ta.selectionStart ?? cur.length;
    const end   = ta.selectionEnd   ?? cur.length;
    const before = cur.slice(0, start);
    const after  = cur.slice(end);
    // Add blank-line buffers if the surrounding text isn't already broken.
    const lead  = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const trail = after && !after.startsWith('\n')   ? '\n' : '';
    const inserted = lead + text + trail;
    const next = before + inserted + after;
    onBodyChange(next);
    // Restore cursor after the inserted block on next tick.
    setTimeout(() => {
      if (bodyRef.current) {
        const pos = (before + inserted).length;
        bodyRef.current.focus();
        bodyRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  }, [body, onBodyChange]);

  const drawerVisible = drawerOpen && isOpen;

  const scheduledLabel = draft.scheduledSendAt
    ? new Date(draft.scheduledSendAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  const CHANNEL_LABEL = { email: '✉️ Email', linkedin: '🔗 LinkedIn', call: '📞 Call', task: '📋 Task' };
  const channelLabel  = CHANNEL_LABEL[channel] || channel;

  // Slice 3: intent badge — surfaces the step_intent the dispatcher used to
  // pick the skill template (first_touch, follow_up, breakup,
  // connection_request, post_accept_message, nurture_dm). Sourced from
  // draft.personalizeSources.stepIntent. Shows the inference source as a
  // secondary marker (Auto vs Override) so the rep can see when a sequence
  // author forced something specific.
  const INTENT_LABEL = {
    first_touch:           'First touch',
    follow_up:             'Follow-up',
    breakup:               'Breakup',
    connection_request:    'Connection req',
    post_accept_message:   'Post-accept DM',
    nurture_dm:            'Nurture DM',
  };
  const INTENT_COLOR = {
    first_touch:           { bg: '#dcfce7', fg: '#166534' },
    follow_up:             { bg: '#dbeafe', fg: '#1e40af' },
    breakup:               { bg: '#fee2e2', fg: '#991b1b' },
    connection_request:    { bg: '#e0e7ff', fg: '#3730a3' },
    post_accept_message:   { bg: '#fef3c7', fg: '#92400e' },
    nurture_dm:            { bg: '#f3e8ff', fg: '#6b21a8' },
  };
  const stepIntent    = draft.personalizeSources?.stepIntent || null;
  const intentSource  = draft.personalizeSources?.intentSource || null;
  const intentLabel   = stepIntent ? INTENT_LABEL[stepIntent] : null;
  const intentColor   = stepIntent ? INTENT_COLOR[stepIntent] : null;

  return (
    <div style={{
      border: `1.5px solid ${overdue ? '#fecaca' : '#e5e7eb'}`,
      borderRadius: 10, background: '#fff', overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', cursor: 'pointer',
          background: overdue ? '#fef2f2' : '#f9fafb',
        }}
      >
        <span style={{ fontSize: 14 }}>{isEmail ? '✉️' : channel === 'linkedin' ? '🔗' : channel === 'call' ? '📞' : '📋'}</span>

        {!compact && (
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', flexShrink: 0 }}>
            {draft.prospect?.firstName} {draft.prospect?.lastName}
            {draft.prospect?.companyName && (
              <span style={{ fontWeight: 400, color: '#9ca3af' }}> · {draft.prospect.companyName}</span>
            )}
          </div>
        )}

        <div style={{
          fontSize: 11, color: '#6b7280',
          padding: '2px 8px', borderRadius: 10,
          background: '#eff6ff', border: '1px solid #bfdbfe',
          flexShrink: 0,
        }}>
          {draft.sequenceName} · step {draft.stepOrder}
        </div>

        {intentLabel && intentColor && (
          <span
            title={intentSource === 'override'
              ? `Intent set explicitly on this step (skill template: ${stepIntent})`
              : `Intent inferred from step position + engagement history (skill template: ${stepIntent})`}
            style={{
              fontSize: 10, fontWeight: 600,
              padding: '2px 8px', borderRadius: 10,
              background: intentColor.bg, color: intentColor.fg,
              border: `1px solid ${intentColor.fg}33`,
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            {intentLabel}
            {intentSource === 'override' && (
              <span style={{ fontSize: 9, opacity: 0.7 }}>●</span>
            )}
          </span>
        )}

        <div style={{
          flex: 1, fontSize: 12, color: '#374151',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {isEmail ? (subject || '(no subject)') : channelLabel}
        </div>

        {overdue ? (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px',
            borderRadius: 10, background: '#fee2e2', color: '#dc2626', flexShrink: 0,
          }}>
            OVERDUE
          </span>
        ) : scheduledLabel && (
          <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>{scheduledLabel}</span>
        )}

        <span style={{ fontSize: 11, color: '#9ca3af' }}>{isOpen ? '▲' : '▼'}</span>
      </div>

      {/* Expanded content + actions */}
      {isOpen && (
        <div style={{ padding: 14, borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* ── EMAIL channel ─────────────────────────────────────────── */}
          {isEmail && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
              {/* Editor column min-width:
                 - In panel context (compact), parent .pv-detail-panel widens via
                   .pv-detail-panel--with-drawer (520→920px) when the drawer opens,
                   so we let this column squeeze (minWidth:0) — the panel handles width.
                 - In all-prospects context (!compact), there's no parent panel to widen
                   (the card sits in a flat tab body). Without a minimum the editor would
                   squeeze unreadably narrow next to the 360px drawer. 360px keeps the
                   subject/body inputs usable on typical desktop widths. */}
              <div style={{ flex: 1, minWidth: compact ? 0 : 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {draft.channelDrift && draft.draftChannel === 'linkedin' && (
                <div style={{ padding: '10px 12px', background: '#fffbeb', borderRadius: 8, border: '1px solid #fcd34d', fontSize: 12, color: '#92400e' }}>
                  ⚡ This step was changed from <strong>LinkedIn</strong> to <strong>Email</strong> after the draft was created. The body below was written for LinkedIn — review and edit before sending.
                </div>
              )}
              {draft.suggestedSender && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    Sending from:{' '}
                    <span style={{
                      fontWeight: 600, color: '#374151',
                      background: '#f3f4f6', padding: '2px 8px', borderRadius: 5,
                    }}>
                      {draft.suggestedSender.provider === 'gmail' ? '📧' : '📮'} {draft.suggestedSender.email}
                      {draft.suggestedSender.label && ` (${draft.suggestedSender.label})`}
                    </span>
                  </div>
                  {linkedinUrl && (
                    <button
                      type="button"
                      onClick={toggleDrawer}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 5,
                        border: `1px solid ${drawerOpen ? '#0077B5' : '#d1d5db'}`,
                        background: drawerOpen ? '#0077B5' : '#fff',
                        color: drawerOpen ? '#fff' : '#374151',
                        cursor: 'pointer', fontWeight: 500, flexShrink: 0,
                      }}
                    >
                      ✨ Personalize
                    </button>
                  )}
                </div>
              )}
              {!draft.suggestedSender && linkedinUrl && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={toggleDrawer}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 5,
                      border: `1px solid ${drawerOpen ? '#0077B5' : '#d1d5db'}`,
                      background: drawerOpen ? '#0077B5' : '#fff',
                      color: drawerOpen ? '#fff' : '#374151',
                      cursor: 'pointer', fontWeight: 500,
                    }}
                  >
                    ✨ Personalize
                  </button>
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  Subject{!subject && <span style={{ color: '#dc2626' }}> *required</span>}
                </label>
                <input
                  value={subject}
                  onChange={e => onSubjectChange(e.target.value)}
                  placeholder={!subject ? 'Enter email subject…' : ''}
                  style={{ width: '100%', padding: '8px 11px', borderRadius: 7, border: `1px solid ${!subject ? '#fca5a5' : '#e5e7eb'}`, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  Body
                </label>
                <textarea
                  ref={bodyRef}
                  value={body}
                  onChange={e => onBodyChange(e.target.value)}
                  rows={8}
                  style={{ width: '100%', padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111', resize: 'vertical', lineHeight: 1.6 }}
                />
                {/* Phase 3: AI provenance — what LinkedIn data the AI saw when drafting */}
                {draft.personalizeSources && (
                  <PersonalizeProvenanceFooter sources={draft.personalizeSources} />
                )}
              </div>
              </div>
              {drawerVisible && (
                <LinkedInDataDrawer
                  linkedinUrl={linkedinUrl}
                  onInsert={handleInsertSnippet}
                  onClose={closeDrawer}
                />
              )}
            </div>
          )}

          {/* ── LINKEDIN channel ──────────────────────────────────────── */}
          {channel === 'linkedin' && (
            <>
              {draft.channelDrift && draft.draftChannel === 'email' && (
                <div style={{ padding: '10px 12px', background: '#fffbeb', borderRadius: 8, border: '1px solid #fcd34d', fontSize: 12, color: '#92400e' }}>
                  ⚡ This step was changed from <strong>Email</strong> to <strong>LinkedIn</strong> after the draft was created. The message below was written as an email — trim it before posting to LinkedIn.
                </div>
              )}
              <div style={{ padding: '10px 12px', background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 6,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    🔗 LinkedIn Message
                  </div>
                  {body && (
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(body);
                      }}
                      style={{
                        padding: '3px 10px', borderRadius: 6, border: '1px solid #bae6fd',
                        background: '#fff', color: '#0369a1', fontSize: 11, fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      📋 Copy message
                    </button>
                  )}
                </div>
                {body ? (
                  <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{body}</div>
                ) : (
                  <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>No message template — send a personalised note.</div>
                )}
              </div>
              {/* Phase 3: AI provenance — same component as email channel for consistency */}
              {draft.personalizeSources && (
                <PersonalizeProvenanceFooter sources={draft.personalizeSources} />
              )}
              {draft.prospect?.linkedinUrl || draft.prospect?.linkedin_url ? (
                <a
                  href={draft.prospect.linkedinUrl || draft.prospect.linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, background: '#0a66c2', color: '#fff', textDecoration: 'none', alignSelf: 'flex-start' }}
                >
                  🔗 Open LinkedIn Profile ↗
                </a>
              ) : (
                <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>
                  No LinkedIn URL on this prospect — add it in their profile.
                </div>
              )}
              <div style={{ fontSize: 11, color: '#6b7280', background: '#f8fafc', borderRadius: 6, padding: '8px 10px' }}>
                💡 Copy the message, open the profile, send it on LinkedIn, then click <strong>Mark as Done</strong> to advance the sequence.
              </div>
            </>
          )}

          {/* ── CALL / TASK channel ───────────────────────────────────── */}
          {(channel === 'call' || channel === 'task') && (
            <>
              <div style={{ padding: '10px 12px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {channel === 'call' ? '📞 Call Note' : '📋 Task Note'}
                </div>
                {draft.taskNote || body ? (
                  <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {draft.taskNote || body}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>No note for this step.</div>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', background: '#f8fafc', borderRadius: 6, padding: '8px 10px' }}>
                💡 {channel === 'call' ? 'Make the call' : 'Complete the task'}, then click <strong>Mark as Done</strong> to advance the sequence.
              </div>
            </>
          )}

          {sendError && (
            <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#dc2626' }}>
              ⚠️ {sendError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={onDiscard}
              style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              🗑 Discard
            </button>
            {isEmail ? (
              <button
                onClick={onSend}
                disabled={sending || !subject}
                title={!subject ? 'Enter a subject line first' : ''}
                style={{
                  padding: '7px 18px', borderRadius: 7, border: 'none',
                  background: (sending || !subject) ? '#9ca3af' : '#0F9D8E', color: '#fff',
                  fontSize: 12, fontWeight: 600, cursor: (sending || !subject) ? 'not-allowed' : 'pointer',
                }}
              >
                {sending ? '⏳ Sending…' : '📤 Send Now'}
              </button>
            ) : (
              <button
                onClick={onComplete}
                disabled={sending}
                style={{
                  padding: '7px 18px', borderRadius: 7, border: 'none',
                  background: sending ? '#9ca3af' : (channel === 'call' ? '#9a3412' : '#0F9D8E'), color: '#fff',
                  fontSize: 12, fontWeight: 600, cursor: sending ? 'not-allowed' : 'pointer',
                }}
              >
                {sending
                  ? '⏳ Saving…'
                  : channel === 'call'
                    ? '📞 Log call & complete'
                    : '✅ Mark as Done'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


export default DraftCard;
