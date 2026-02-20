import React, { useState, useEffect } from 'react';
import './EmailComposer.css';

/**
 * EmailComposer
 *
 * Props:
 *   email        {object}   — existing email to reply to (optional)
 *   contacts     {array}    — all contacts for recipient dropdown
 *   deals        {array}    — all deals for deal association dropdown
 *   onSubmit     {function} — async (emailData) => void — called after send
 *   onClose      {function} — close the modal
 *
 *   // Action-triggered prefill (when opened from an action card Start button)
 *   prefill      {object?}  — { contactId, dealId, subject, body, toAddress }
 *   actionId     {number?}  — action that triggered this compose session
 *   actionContext {object?} — { title, suggestedAction, nextStep } for the banner
 */
function EmailComposer({ email, contacts, deals, onSubmit, onClose, prefill, actionId, actionContext }) {
  const [formData, setFormData] = useState({
    contact_id: '',
    deal_id:    '',
    subject:    '',
    body:       '',
    template:   '',
  });

  const [errors,      setErrors]      = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sendResult,   setSendResult]   = useState(null); // { outlookSent, outlookError }

  // Email templates
  const templates = {
    follow_up: {
      subject: 'Following up on our conversation',
      body:    'Hi [Name],\n\nI wanted to follow up on our recent conversation about [Topic].\n\n[Your message here]\n\nLooking forward to hearing from you.\n\nBest regards,',
    },
    demo_invite: {
      subject: 'Demo Invitation - [Product Name]',
      body:    'Hi [Name],\n\nI\'d like to invite you to a personalised demo of [Product Name].\n\nWould you be available for a 30-minute session this week?\n\nBest regards,',
    },
    proposal: {
      subject: 'Proposal for [Company Name]',
      body:    'Hi [Name],\n\nAttached is our proposal for [Company Name].\n\nKey highlights:\n- [Point 1]\n- [Point 2]\n- [Point 3]\n\nLet me know if you have any questions.\n\nBest regards,',
    },
    thank_you: {
      subject: 'Thank you for your time',
      body:    'Hi [Name],\n\nThank you for taking the time to meet with me today.\n\nI appreciate the opportunity to discuss [Topic] with you.\n\nBest regards,',
    },
  };

  // ── Populate form on mount ────────────────────────────────────────────────

  useEffect(() => {
    if (prefill) {
      // Opened from an action card — pre-fill with action context
      setFormData({
        contact_id: prefill.contactId ? String(prefill.contactId) : '',
        deal_id:    prefill.dealId    ? String(prefill.dealId)    : '',
        subject:    prefill.subject   || '',
        body:       prefill.body      || '',
        template:   '',
      });
    } else if (email) {
      // Reply mode
      setFormData({
        contact_id: email.contact_id ? String(email.contact_id) : '',
        deal_id:    email.deal_id    ? String(email.deal_id)    : '',
        subject:    email.subject    ? `Re: ${email.subject}`   : '',
        body:       email.body       ? `\n\n--- Original Message ---\n${email.body}` : '',
        template:   '',
      });
    }
  }, [prefill, email]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: null }));
  };

  const handleTemplateChange = (e) => {
    const key = e.target.value;
    if (key && templates[key]) {
      setFormData(prev => ({ ...prev, template: key, subject: templates[key].subject, body: templates[key].body }));
    } else {
      setFormData(prev => ({ ...prev, template: key }));
    }
  };

  const validateForm = () => {
    const newErrors = {};
    if (!formData.contact_id)       newErrors.contact_id = 'Please select a recipient';
    if (!formData.subject.trim())   newErrors.subject    = 'Subject is required';
    if (!formData.body.trim())      newErrors.body       = 'Email body is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;
    setIsSubmitting(true);
    setSendResult(null);

    try {
      const selectedContact = contacts.find(c => c.id === parseInt(formData.contact_id));
      const toAddress = selectedContact?.email || '';

      const { template, ...emailData } = formData;

      // Pass actionId and toAddress through to onSubmit
      const result = await onSubmit({
        ...emailData,
        toAddress,
        actionId: actionId || null,
      });

      // Surface Outlook send status if returned
      if (result?.outlookSent === false && result?.outlookError) {
        setSendResult({
          outlookSent:  false,
          outlookError: result.outlookError,
        });
      } else if (result?.outlookSent) {
        setSendResult({ outlookSent: true });
      }

      // If no Outlook error surfaced, close after short delay
      if (!result?.outlookError) {
        setTimeout(onClose, 800);
      }

    } catch (err) {
      console.error('Email send error:', err);
      setErrors({ submit: 'Failed to send email. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedContact = contacts.find(c => c.id === parseInt(formData.contact_id));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content email-composer-modal" onClick={e => e.stopPropagation()}>

        <div className="modal-header">
          <h2>{email ? 'Reply to Email' : 'Compose Email'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        {/* Action context banner — shown when opened from an action card */}
        {actionContext && (
          <div className="ec-action-banner">
            <div className="ec-action-banner-label">✉️ Sending for action</div>
            <div className="ec-action-banner-title">{actionContext.title}</div>
            {actionContext.suggestedAction && (
              <div className="ec-action-banner-hint">
                <span className="ec-action-banner-hint-label">Suggested:</span>
                {actionContext.suggestedAction}
              </div>
            )}
          </div>
        )}

        {/* Outlook send result banner */}
        {sendResult && (
          <div className={`ec-send-result ${sendResult.outlookSent ? 'ec-send-result--ok' : 'ec-send-result--warn'}`}>
            {sendResult.outlookSent
              ? '✅ Sent via Outlook — check your Sent Items'
              : `⚠️ Saved to CRM but Outlook send failed: ${sendResult.outlookError}. Check your Outlook connection in Settings.`}
          </div>
        )}

        <form onSubmit={handleSubmit} className="email-composer-form">

          {/* Recipient */}
          <div className="form-group">
            <label htmlFor="contact_id">To: <span className="required">*</span></label>
            <select
              id="contact_id"
              name="contact_id"
              value={formData.contact_id}
              onChange={handleChange}
              className={errors.contact_id ? 'error' : ''}
              disabled={!!email || !!prefill?.contactId}
            >
              <option value="">Select recipient…</option>
              {contacts.map(c => (
                <option key={c.id} value={c.id}>
                  {c.first_name} {c.last_name} ({c.email})
                  {c.account ? ` — ${c.account.name}` : ''}
                </option>
              ))}
            </select>
            {errors.contact_id && <span className="error-message">{errors.contact_id}</span>}
            {selectedContact && (
              <div className="recipient-info">
                <span className="info-icon">📧</span>
                {selectedContact.email}
                {selectedContact.account && (
                  <span className="company-badge">{selectedContact.account.name}</span>
                )}
              </div>
            )}
          </div>

          {/* Deal */}
          <div className="form-group">
            <label htmlFor="deal_id">Related Deal (Optional)</label>
            <select
              id="deal_id"
              name="deal_id"
              value={formData.deal_id}
              onChange={handleChange}
              disabled={!!prefill?.dealId}
            >
              <option value="">No deal selected</option>
              {deals
                .filter(d => !formData.contact_id || d.account_id === selectedContact?.account_id)
                .map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} — ${parseFloat(d.value || 0).toLocaleString()}
                  </option>
                ))}
            </select>
          </div>

          {/* Template — only when not prefilled from an action */}
          {!email && !prefill && (
            <div className="form-group">
              <label htmlFor="template">Use Template (Optional)</label>
              <select id="template" name="template" value={formData.template} onChange={handleTemplateChange}>
                <option value="">No template — start from scratch</option>
                <option value="follow_up">Follow-up Email</option>
                <option value="demo_invite">Demo Invitation</option>
                <option value="proposal">Proposal</option>
                <option value="thank_you">Thank You</option>
              </select>
            </div>
          )}

          {/* Subject */}
          <div className="form-group">
            <label htmlFor="subject">Subject <span className="required">*</span></label>
            <input
              type="text"
              id="subject"
              name="subject"
              value={formData.subject}
              onChange={handleChange}
              placeholder="Email subject"
              className={errors.subject ? 'error' : ''}
            />
            {errors.subject && <span className="error-message">{errors.subject}</span>}
          </div>

          {/* Body */}
          <div className="form-group">
            <label htmlFor="body">Message <span className="required">*</span></label>
            <textarea
              id="body"
              name="body"
              value={formData.body}
              onChange={handleChange}
              placeholder="Type your message here…"
              rows="12"
              className={errors.body ? 'error' : ''}
            />
            {errors.body && <span className="error-message">{errors.body}</span>}
            <div className="character-count">{formData.body.length} characters</div>
          </div>

          {errors.submit && <div className="error-banner">{errors.submit}</div>}

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Sending…' : '📤 Send Email'}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}

export default EmailComposer;
