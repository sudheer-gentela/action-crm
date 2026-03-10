import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

/**
 * OutreachComposer
 *
 * Multi-channel outreach composer for the Prospecting module.
 * Adapts its UI by channel: email (full compose with sender selector + AI draft),
 * linkedin/sms/whatsapp (copy-to-clipboard), phone (call script + outcome).
 *
 * Props:
 *   prospect        {object}   — { id, first_name, last_name, email, phone, linkedin_url, company_name, stage }
 *   initialChannel  {string?}  — 'email'|'linkedin'|'phone'|'sms'|'whatsapp'
 *   actionToExecute {object?}  — existing prospecting_action to execute (prefills subject/body)
 *   onComplete      {function} — called after successful send/log with result data
 *   onClose         {function} — close the composer
 */

const CHANNELS = [
  { key: 'email',    icon: '✉️',  label: 'Email' },
  { key: 'linkedin', icon: '🔗', label: 'LinkedIn' },
  { key: 'phone',    icon: '📞', label: 'Phone' },
  { key: 'sms',      icon: '💬', label: 'SMS' },
  { key: 'whatsapp', icon: '📱', label: 'WhatsApp' },
];

const PHONE_OUTCOMES = [
  { key: 'call_connected', label: 'Connected' },
  { key: 'voicemail',      label: 'Voicemail' },
  { key: 'no_answer',      label: 'No Answer' },
  { key: 'meeting_booked', label: 'Meeting Booked' },
];

const MESSAGE_OUTCOMES = [
  { key: 'sent',           label: 'Sent' },
  { key: 'replied',        label: 'Got Reply' },
  { key: 'no_response',    label: 'No Response' },
  { key: 'meeting_booked', label: 'Meeting Booked' },
];

const EMAIL_OUTCOMES = [
  { key: 'sent',    label: 'Sent' },
  { key: 'bounced', label: 'Bounced' },
];

const PROVIDER_BADGE = {
  gmail:   { label: 'G', color: '#ea4335', bg: '#fef2f2' },
  outlook: { label: 'O', color: '#0078d4', bg: '#eff6ff' },
};

function ProviderBadge({ provider }) {
  const cfg = PROVIDER_BADGE[provider] || { label: '?', color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}30`,
      flexShrink: 0,
    }}>
      {cfg.label}
    </span>
  );
}

function OutreachComposer({ prospect, initialChannel, actionToExecute, onComplete, onClose }) {
  const [channel, setChannel]         = useState(initialChannel || 'email');
  const [subject, setSubject]         = useState('');
  const [body, setBody]               = useState('');
  const [outcome, setOutcome]         = useState('');
  const [notes, setNotes]             = useState('');
  const [sending, setSending]         = useState(false);
  const [error, setError]             = useState('');
  const [copied, setCopied]           = useState(false);
  const [success, setSuccess]         = useState(false);

  // Sender accounts
  const [senders, setSenders]         = useState([]);
  const [selectedSender, setSelectedSender] = useState(null);
  const [sendersLoading, setSendersLoading] = useState(true);
  const [rateLimitInfo, setRateLimitInfo]   = useState(null); // { nextAllowedAt, dailySent, dailyLimit }

  // AI draft
  const [drafting, setDrafting]       = useState(false);

  // ── Load sender accounts on mount ─────────────────────────────────────────
  useEffect(() => {
    if (channel !== 'email') return;
    setSendersLoading(true);
    apiService.prospectingSenders.getAll()
      .then(r => {
        const list = r.data?.senders || [];
        setSenders(list);
        if (list.length > 0 && !selectedSender) {
          setSelectedSender(list[0].id);
        }
      })
      .catch(() => setSenders([]))
      .finally(() => setSendersLoading(false));
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Prefill from action if provided ───────────────────────────────────────
  useEffect(() => {
    if (actionToExecute) {
      if (actionToExecute.channel) setChannel(actionToExecute.channel);
      if (actionToExecute.messageSubject || actionToExecute.message_subject) {
        setSubject(actionToExecute.messageSubject || actionToExecute.message_subject || '');
      }
      if (actionToExecute.messageBody || actionToExecute.message_body) {
        setBody(actionToExecute.messageBody || actionToExecute.message_body || '');
      }
    }
  }, [actionToExecute]);

  // ── AI Draft ──────────────────────────────────────────────────────────────
  const handleAiDraft = async () => {
    setDrafting(true);
    setError('');
    try {
      // Call the backend research endpoint to get / refresh context
      // then use that to pre-fill. We call the AI model directly via
      // the Anthropic API using the prospect data we already have.
      const res = await apiService.prospects.research(prospect.id);
      const { researchNotes } = res.data;

      // Build a suggested subject and body from research notes
      const firstName = prospect.first_name;
      const company   = prospect.company_name || '';

      const lines = (researchNotes || '').split('\n').filter(l => l.trim());
      const topLine = lines[0]?.replace(/^[•\-*]\s*/, '') || '';

      // Simple templating — keeps things fast and deterministic
      if (!subject) {
        setSubject(`Quick question for ${firstName}${company ? ` at ${company}` : ''}`);
      }

      if (!body) {
        setBody(
          `Hi ${firstName},\n\n` +
          `${topLine}\n\n` +
          `I'd love to explore whether we could help — would you be open to a quick 20-minute call this week?\n\n` +
          `Best,`
        );
      }
    } catch (err) {
      setError('AI draft failed: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setDrafting(false);
    }
  };

  // ── Copy to clipboard ──────────────────────────────────────────────────────
  const handleCopy = async () => {
    const text = subject ? `${subject}\n\n${body}` : body;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Send / Log ─────────────────────────────────────────────────────────────
  const handleSend = async () => {
    setError('');
    setRateLimitInfo(null);

    if (channel === 'email') {
      if (!subject.trim()) { setError('Subject is required'); return; }
      if (!body.trim())    { setError('Message body is required'); return; }
      if (senders.length > 0 && !selectedSender) { setError('Select a sender account'); return; }
    }
    if (channel === 'phone' && !outcome) {
      setError('Please select a call outcome'); return;
    }

    setSending(true);

    try {
      let result;

      if (channel === 'email' && !actionToExecute) {
        // Use the new outreach-send endpoint (actual email send + rate limiting)
        const res = await apiService.prospectingActions.outreachSend({
          prospectId:      prospect.id,
          subject,
          body,
          toAddress:       prospect.email,
          senderAccountId: selectedSender || undefined,
        });
        result = res.data;
      } else if (actionToExecute) {
        // Execute existing action (non-email or email with pre-existing action)
        if (channel === 'email' && prospect.email) {
          const res = await apiService.prospectingActions.outreachSend({
            prospectId:      prospect.id,
            subject,
            body,
            toAddress:       prospect.email,
            senderAccountId: selectedSender || undefined,
            actionId:        actionToExecute.id || actionToExecute.actionId,
          });
          result = res.data;
        } else {
          const res = await apiService.prospectingActions.execute(
            actionToExecute.id || actionToExecute.actionId,
            outcome || 'sent',
            notes || body || ''
          );
          result = { action: res.data?.action };
        }
      } else {
        // Non-email channel: create + complete action
        const res = await apiService.prospectingActions.execute(
          // For non-email we create a new action inline then execute
          // Fall back to legacy execute path — create action first
          null,
          outcome || 'sent',
          notes || body || ''
        );
        result = res.data;
      }

      setSuccess(true);
      setTimeout(() => {
        if (onComplete) onComplete(result);
      }, 600);

    } catch (err) {
      const errData = err.response?.data?.error;
      if (err.response?.status === 429) {
        setRateLimitInfo(errData);
        setError(errData?.message || 'Rate limit reached. Please wait before sending again.');
      } else {
        setError(errData?.message || err.message || 'Failed to send outreach');
      }
    } finally {
      setSending(false);
    }
  };

  const outcomeOptions = channel === 'phone' ? PHONE_OUTCOMES
    : channel === 'email' ? EMAIL_OUTCOMES
    : MESSAGE_OUTCOMES;

  const selectedSenderObj = senders.find(s => s.id === selectedSender);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="oc-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="oc-header">
          <div className="oc-header-left">
            <h3 className="oc-title">
              {CHANNELS.find(c => c.key === channel)?.icon} Outreach
            </h3>
            <span className="oc-prospect-name">
              to {prospect.first_name} {prospect.last_name}
              {prospect.company_name ? ` at ${prospect.company_name}` : ''}
            </span>
          </div>
          <button className="oc-close" onClick={onClose}>×</button>
        </div>

        {/* Success banner */}
        {success && (
          <div className="oc-success-banner">✅ Outreach logged successfully!</div>
        )}

        {/* Channel tabs */}
        <div className="oc-channel-tabs">
          {CHANNELS.map(ch => {
            const disabled =
              (ch.key === 'email'    && !prospect.email) ||
              (ch.key === 'phone'    && !prospect.phone) ||
              (ch.key === 'linkedin' && !prospect.linkedin_url);
            return (
              <button
                key={ch.key}
                className={`oc-channel-tab ${channel === ch.key ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                onClick={() => !disabled && setChannel(ch.key)}
                disabled={disabled}
                title={disabled ? `No ${ch.label.toLowerCase()} on file` : ch.label}
              >
                <span className="oc-ch-icon">{ch.icon}</span>
                <span className="oc-ch-label">{ch.label}</span>
              </button>
            );
          })}
        </div>

        {/* Action context banner */}
        {actionToExecute && (
          <div className="oc-action-banner">
            <span className="oc-action-banner-icon">📋</span>
            <span>Executing: <strong>{actionToExecute.title}</strong></span>
          </div>
        )}

        {/* Channel-specific content */}
        <div className="oc-body">

          {/* ── EMAIL ──────────────────────────────────────────────────────── */}
          {channel === 'email' && (
            <>
              {/* Sender account selector */}
              <div className="oc-field">
                <label>From</label>
                {sendersLoading ? (
                  <div className="oc-sender-loading">Loading accounts…</div>
                ) : senders.length === 0 ? (
                  <div className="oc-no-senders">
                    No outreach accounts connected.{' '}
                    <a
                      href="#settings"
                      onClick={e => {
                        e.preventDefault();
                        window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'settings', settingsTab: 'preferences' } }));
                        onClose();
                      }}
                    >
                      Connect one in Settings → My Preferences
                    </a>
                  </div>
                ) : (
                  <div className="oc-sender-select-wrap">
                    <select
                      className="oc-sender-select"
                      value={selectedSender || ''}
                      onChange={e => setSelectedSender(parseInt(e.target.value))}
                    >
                      {senders.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.label ? `${s.label} — ` : ''}{s.email}  [{s.provider}]
                        </option>
                      ))}
                    </select>
                    {selectedSenderObj && (
                      <div className="oc-sender-meta">
                        <ProviderBadge provider={selectedSenderObj.provider} />
                        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 4 }}>
                          {selectedSenderObj.emailsSentToday ?? 0} sent today
                          {selectedSenderObj.dailyLimit ? ` / ${selectedSenderObj.dailyLimit} limit` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="oc-field">
                <label>To</label>
                <div className="oc-to-display">{prospect.email || 'No email on file'}</div>
              </div>

              {/* Subject with AI Draft button */}
              <div className="oc-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label>Subject <span className="oc-required">*</span></label>
                  <button
                    className="oc-ai-draft-btn"
                    onClick={handleAiDraft}
                    disabled={drafting}
                    title="Generate a personalised draft using AI research"
                    style={{
                      fontSize: 11, padding: '3px 10px', borderRadius: 6,
                      border: '1px solid #8b5cf6', background: '#f5f3ff',
                      color: '#7c3aed', cursor: drafting ? 'wait' : 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    {drafting ? '⏳ Drafting…' : '✨ AI Draft'}
                  </button>
                </div>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Email subject..."
                  className="oc-input"
                />
              </div>

              <div className="oc-field">
                <label>Message <span className="oc-required">*</span></label>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  placeholder={`Hi ${prospect.first_name},\n\n`}
                  rows={10}
                  className="oc-textarea"
                />
                <div className="oc-char-count">{body.length} characters</div>
              </div>

              {/* Rate limit info */}
              {rateLimitInfo?.nextAllowedAt && (
                <div style={{
                  padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a',
                  borderRadius: 6, fontSize: 12, color: '#92400e', marginBottom: 8,
                }}>
                  ⏱ Next send allowed at {new Date(rateLimitInfo.nextAllowedAt).toLocaleTimeString()}
                </div>
              )}
            </>
          )}

          {/* ── LINKEDIN / SMS / WHATSAPP ─────────────────────────────────── */}
          {['linkedin', 'sms', 'whatsapp'].includes(channel) && (
            <>
              {channel === 'linkedin' && prospect.linkedin_url && (
                <div className="oc-field">
                  <label>LinkedIn Profile</label>
                  <a href={prospect.linkedin_url} target="_blank" rel="noreferrer" className="oc-link">
                    {prospect.linkedin_url} ↗
                  </a>
                </div>
              )}
              <div className="oc-field">
                <label>Message</label>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  placeholder={`Hi ${prospect.first_name}, ...`}
                  rows={6}
                  className="oc-textarea"
                />
              </div>
              <button
                className="oc-copy-btn"
                onClick={handleCopy}
                disabled={!body.trim()}
              >
                {copied ? '✅ Copied!' : '📋 Copy to Clipboard'}
              </button>
              <div className="oc-manual-note">
                Copy your message, send it on {channel === 'linkedin' ? 'LinkedIn' : channel === 'sms' ? 'your phone' : 'WhatsApp'}, then log the outcome below.
              </div>
            </>
          )}

          {/* ── PHONE ──────────────────────────────────────────────────────── */}
          {channel === 'phone' && (
            <>
              <div className="oc-field">
                <label>Phone Number</label>
                <div className="oc-to-display">
                  {prospect.phone ? (
                    <a href={`tel:${prospect.phone}`} className="oc-link">{prospect.phone}</a>
                  ) : 'No phone on file'}
                </div>
              </div>
              <div className="oc-field">
                <label>Call Script / Talking Points</label>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  placeholder="Key talking points, questions to ask, objection handling..."
                  rows={6}
                  className="oc-textarea"
                />
              </div>
              <div className="oc-divider" />
            </>
          )}

          {/* ── Outcome selector (all channels) ──────────────────────────── */}
          <div className="oc-field">
            <label>{channel === 'phone' ? 'Call Outcome *' : 'Outcome'}</label>
            <div className="oc-outcome-grid">
              {outcomeOptions.map(o => (
                <button
                  key={o.key}
                  className={`oc-outcome-btn ${outcome === o.key ? 'active' : ''}`}
                  onClick={() => setOutcome(outcome === o.key ? '' : o.key)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div className="oc-field">
            <label>Notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any additional notes about this outreach..."
              rows={2}
              className="oc-textarea oc-textarea-sm"
            />
          </div>
        </div>

        {/* Error */}
        {error && <div className="oc-error">{error}</div>}

        {/* Footer */}
        <div className="oc-footer">
          <button className="oc-btn-cancel" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            className="oc-btn-send"
            onClick={handleSend}
            disabled={sending || success || (channel === 'email' && !prospect.email)}
          >
            {sending ? 'Sending...' :
              channel === 'email' ? '📤 Send Email' :
              channel === 'phone' ? '📞 Log Call' :
              '✓ Mark as Sent'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default OutreachComposer;
