import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

/**
 * OutreachComposer
 *
 * Multi-channel outreach composer for the Prospecting module.
 * Adapts its UI by channel: email (full compose), linkedin/sms/whatsapp
 * (copy-to-clipboard), phone (call script + outcome).
 *
 * Props:
 *   prospect      {object}   — { id, first_name, last_name, email, phone, linkedin_url, company_name, stage }
 *   initialChannel {string?} — 'email'|'linkedin'|'phone'|'sms'|'whatsapp'
 *   actionToExecute {object?} — existing prospecting_action to execute (prefills subject/body)
 *   onComplete     {function} — called after successful send/log with { action, emailId? }
 *   onClose        {function} — close the composer
 */

const TEAL = '#0F9D8E';

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
  { key: 'sent',           label: 'Sent' },
  { key: 'bounced',        label: 'Bounced' },
];

function OutreachComposer({ prospect, initialChannel, actionToExecute, onComplete, onClose }) {
  const [channel, setChannel] = useState(initialChannel || 'email');
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState('');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes]     = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError]     = useState('');
  const [copied, setCopied]   = useState(false);
  const [success, setSuccess] = useState(false);

  // Prefill from action if provided
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

  // ── Copy to clipboard ──────────────────────────────────────────────────────

  const handleCopy = async () => {
    const text = subject ? `${subject}\n\n${body}` : body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // ── Send / Log ─────────────────────────────────────────────────────────────

  const handleSend = async () => {
    setError('');

    // Validation
    if (channel === 'email') {
      if (!subject.trim()) { setError('Subject is required for email'); return; }
      if (!body.trim()) { setError('Message body is required'); return; }
    }
    if (channel === 'phone' && !outcome) {
      setError('Please select a call outcome'); return;
    }

    setSending(true);

    try {
      let result;

      if (actionToExecute) {
        // Execute existing action
        result = await apiService.prospectingActions.execute(
          actionToExecute.id || actionToExecute.actionId,
          outcome || 'sent',
          notes || body || ''
        );
        result = { action: result.data?.action };
      } else {
        // Create + complete via outreach-send endpoint
        const res = await apiService.prospectingActions.outreachSend({
          prospectId: prospect.id,
          channel,
          subject: subject || null,
          body: body || null,
          outcome: outcome || 'sent',
          notes: notes || null,
          toAddress: prospect.email || null,
        });
        result = res.data;
      }

      setSuccess(true);
      setTimeout(() => {
        if (onComplete) onComplete(result);
      }, 600);
    } catch (err) {
      console.error('Outreach send error:', err);
      setError(err.response?.data?.error?.message || err.message || 'Failed to send outreach');
    } finally {
      setSending(false);
    }
  };

  // ── Determine which outcomes to show ───────────────────────────────────────

  const outcomeOptions = channel === 'phone' ? PHONE_OUTCOMES
    : channel === 'email' ? EMAIL_OUTCOMES
    : MESSAGE_OUTCOMES;

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
            // Disable channels without contact info
            const disabled =
              (ch.key === 'email' && !prospect.email) ||
              (ch.key === 'phone' && !prospect.phone) ||
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

          {/* ── EMAIL ────────────────────────────────────────────────────── */}
          {channel === 'email' && (
            <>
              <div className="oc-field">
                <label>To</label>
                <div className="oc-to-display">{prospect.email || 'No email on file'}</div>
              </div>
              <div className="oc-field">
                <label>Subject <span className="oc-required">*</span></label>
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
            </>
          )}

          {/* ── LINKEDIN / SMS / WHATSAPP ──────────────────────────────── */}
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

          {/* ── PHONE ──────────────────────────────────────────────────── */}
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

          {/* ── Outcome selector (all channels) ──────────────────────── */}
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

        {/* Footer actions */}
        <div className="oc-footer">
          <button className="oc-btn-cancel" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            className="oc-btn-send"
            onClick={handleSend}
            disabled={sending || success}
          >
            {sending ? 'Sending...' :
              channel === 'email' ? '📤 Send Email' :
              channel === 'phone' ? '📞 Log Call' :
              `✓ Mark as Sent`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default OutreachComposer;
