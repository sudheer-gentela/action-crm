import React, { useState, useEffect } from 'react';
import './EmailComposer.css';

function EmailComposer({ email, contacts, deals, onSubmit, onClose }) {
  const [formData, setFormData] = useState({
    contact_id: '',
    deal_id: '',
    subject: '',
    body: '',
    template: ''
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Email templates
  const templates = {
    follow_up: {
      subject: 'Following up on our conversation',
      body: 'Hi [Name],\n\nI wanted to follow up on our recent conversation about [Topic].\n\n[Your message here]\n\nLooking forward to hearing from you.\n\nBest regards,'
    },
    demo_invite: {
      subject: 'Demo Invitation - [Product Name]',
      body: 'Hi [Name],\n\nI\'d like to invite you to a personalized demo of [Product Name].\n\nWould you be available for a 30-minute session this week?\n\nBest regards,'
    },
    proposal: {
      subject: 'Proposal for [Company Name]',
      body: 'Hi [Name],\n\nAttached is our proposal for [Company Name].\n\nKey highlights:\n- [Point 1]\n- [Point 2]\n- [Point 3]\n\nLet me know if you have any questions.\n\nBest regards,'
    },
    thank_you: {
      subject: 'Thank you for your time',
      body: 'Hi [Name],\n\nThank you for taking the time to meet with me today.\n\nI appreciate the opportunity to discuss [Topic] with you.\n\nBest regards,'
    }
  };

  // Populate form if replying/forwarding
  useEffect(() => {
    if (email) {
  //    const contact = contacts.find(c => c.id === email.contact_id);
      setFormData({
        contact_id: email.contact_id || '',
        deal_id: email.deal_id || '',
        subject: email.subject ? `Re: ${email.subject}` : '',
        body: email.body ? `\n\n--- Original Message ---\n${email.body}` : '',
        template: ''
      });
    }
  }, [email, contacts]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    if (errors[name]) {
      setErrors(prev => ({
        ...prev,
        [name]: null
      }));
    }
  };

  const handleTemplateChange = (e) => {
    const templateKey = e.target.value;
    setFormData(prev => ({
      ...prev,
      template: templateKey
    }));

    if (templateKey && templates[templateKey]) {
      setFormData(prev => ({
        ...prev,
        subject: templates[templateKey].subject,
        body: templates[templateKey].body,
        template: templateKey
      }));
    }
  };

  const validateForm = () => {
    const newErrors = {};

    if (!formData.contact_id) {
      newErrors.contact_id = 'Please select a recipient';
    }

    if (!formData.subject.trim()) {
      newErrors.subject = 'Subject is required';
    }

    if (!formData.body.trim()) {
      newErrors.body = 'Email body is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Remove template field before submitting
      const { template, ...emailData } = formData;
      await onSubmit(emailData);
    } catch (error) {
      console.error('Error submitting email:', error);
      setErrors({ submit: 'Failed to send email. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedContact = contacts.find(c => c.id === parseInt(formData.contact_id));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content email-composer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{email ? 'Reply to Email' : 'Compose Email'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="email-composer-form">
          {/* Recipient Selection */}
          <div className="form-group">
            <label htmlFor="contact_id">
              To: <span className="required">*</span>
            </label>
            <select
              id="contact_id"
              name="contact_id"
              value={formData.contact_id}
              onChange={handleChange}
              className={errors.contact_id ? 'error' : ''}
              disabled={!!email}
            >
              <option value="">Select recipient...</option>
              {contacts.map(contact => (
                <option key={contact.id} value={contact.id}>
                  {contact.first_name} {contact.last_name} ({contact.email})
                  {contact.account ? ` - ${contact.account.name}` : ''}
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

          {/* Deal Association */}
          <div className="form-group">
            <label htmlFor="deal_id">Related Deal (Optional)</label>
            <select
              id="deal_id"
              name="deal_id"
              value={formData.deal_id}
              onChange={handleChange}
            >
              <option value="">No deal selected</option>
              {deals
                .filter(d => !formData.contact_id || d.account_id === selectedContact?.account_id)
                .map(deal => (
                  <option key={deal.id} value={deal.id}>
                    {deal.name} - ${parseFloat(deal.value).toLocaleString()}
                  </option>
                ))}
            </select>
          </div>

          {/* Template Selection */}
          {!email && (
            <div className="form-group">
              <label htmlFor="template">Use Template (Optional)</label>
              <select
                id="template"
                name="template"
                value={formData.template}
                onChange={handleTemplateChange}
              >
                <option value="">No template - Start from scratch</option>
                <option value="follow_up">Follow-up Email</option>
                <option value="demo_invite">Demo Invitation</option>
                <option value="proposal">Proposal</option>
                <option value="thank_you">Thank You</option>
              </select>
            </div>
          )}

          {/* Subject */}
          <div className="form-group">
            <label htmlFor="subject">
              Subject <span className="required">*</span>
            </label>
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

          {/* Email Body */}
          <div className="form-group">
            <label htmlFor="body">
              Message <span className="required">*</span>
            </label>
            <textarea
              id="body"
              name="body"
              value={formData.body}
              onChange={handleChange}
              placeholder="Type your message here..."
              rows="12"
              className={errors.body ? 'error' : ''}
            />
            {errors.body && <span className="error-message">{errors.body}</span>}
            <div className="character-count">
              {formData.body.length} characters
            </div>
          </div>

          {/* Submit Error */}
          {errors.submit && (
            <div className="error-banner">
              {errors.submit}
            </div>
          )}

          {/* Form Actions */}
          <div className="form-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Sending...' : '📤 Send Email'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default EmailComposer;
