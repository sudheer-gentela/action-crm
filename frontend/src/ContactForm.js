import React, { useState, useEffect } from 'react';
import './ContactForm.css';

function ContactForm({ contact, accounts, onSubmit, onClose }) {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    title: '',
    accountId: '',
    roleType: '',
    engagementLevel: 'medium',
    location: '',
    linkedinUrl: '',
    notes: ''
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Populate form if editing
  useEffect(() => {
    if (contact) {
      setFormData({
        firstName: contact.first_name || '',
        lastName: contact.last_name || '',
        email: contact.email || '',
        phone: contact.phone || '',
        title: contact.title || '',
        accountId: contact.account_id || '',
        roleType: contact.role_type || '',
        engagementLevel: contact.engagement_level || 'medium',
        location: contact.location || '',
        linkedinUrl: contact.linkedin_url || '',
        notes: contact.notes || ''
      });
    }
  }, [contact]);

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

  const validateForm = () => {
    const newErrors = {};

    if (!formData.firstName.trim()) {
      newErrors.firstName = 'First name is required';
    }

    if (!formData.lastName.trim()) {
      newErrors.lastName = 'Last name is required';
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!formData.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (formData.phone && !formData.phone.match(/^[\d\s\-\+\(\)]+$/)) {
      newErrors.phone = 'Please enter a valid phone number';
    }

    if (!formData.accountId) {
      newErrors.accountId = 'Please select an account';
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
      await onSubmit(formData);
    } catch (error) {
      console.error('Error submitting form:', error);
      setErrors({ submit: 'Failed to save contact. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{contact ? 'Edit Contact' : 'New Contact'}</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="contact-form">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="firstName">
                First Name <span className="required">*</span>
              </label>
              <input
                type="text"
                id="firstName"
                name="firstName"
                value={formData.firstName}
                onChange={handleChange}
                className={errors.firstName ? 'error' : ''}
                placeholder="Enter first name"
              />
              {errors.firstName && <span className="error-message">{errors.firstName}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="lastName">
                Last Name <span className="required">*</span>
              </label>
              <input
                type="text"
                id="lastName"
                name="lastName"
                value={formData.lastName}
                onChange={handleChange}
                className={errors.lastName ? 'error' : ''}
                placeholder="Enter last name"
              />
              {errors.lastName && <span className="error-message">{errors.lastName}</span>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="email">
                Email <span className="required">*</span>
              </label>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                className={errors.email ? 'error' : ''}
                placeholder="contact@company.com"
              />
              {errors.email && <span className="error-message">{errors.email}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="phone">Phone</label>
              <input
                type="tel"
                id="phone"
                name="phone"
                value={formData.phone}
                onChange={handleChange}
                className={errors.phone ? 'error' : ''}
                placeholder="+1-555-123-4567"
              />
              {errors.phone && <span className="error-message">{errors.phone}</span>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="title">Job Title</label>
              <input
                type="text"
                id="title"
                name="title"
                value={formData.title}
                onChange={handleChange}
                placeholder="VP of Sales"
              />
            </div>

            <div className="form-group">
              <label htmlFor="accountId">
                Account <span className="required">*</span>
              </label>
              <select
                id="accountId"
                name="accountId"
                value={formData.accountId}
                onChange={handleChange}
                className={errors.accountId ? 'error' : ''}
              >
                <option value="">Select account...</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
              {errors.accountId && <span className="error-message">{errors.accountId}</span>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="roleType">Role Type</label>
              <select
                id="roleType"
                name="roleType"
                value={formData.roleType}
                onChange={handleChange}
              >
                <option value="">Select role...</option>
                <option value="decision_maker">Decision Maker</option>
                <option value="influencer">Influencer</option>
                <option value="champion">Champion</option>
                <option value="blocker">Blocker</option>
                <option value="end_user">End User</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="engagementLevel">Engagement Level</label>
              <select
                id="engagementLevel"
                name="engagementLevel"
                value={formData.engagementLevel}
                onChange={handleChange}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location</label>
            <input
              type="text"
              id="location"
              name="location"
              value={formData.location}
              onChange={handleChange}
              placeholder="San Francisco, CA"
            />
          </div>

          <div className="form-group">
            <label htmlFor="linkedinUrl">LinkedIn URL</label>
            <input
              type="url"
              id="linkedinUrl"
              name="linkedinUrl"
              value={formData.linkedinUrl}
              onChange={handleChange}
              placeholder="https://linkedin.com/in/username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="notes">Notes</label>
            <textarea
              id="notes"
              name="notes"
              value={formData.notes}
              onChange={handleChange}
              rows="3"
              placeholder="Additional notes about this contact..."
            />
          </div>

          {errors.submit && (
            <div className="error-message submit-error">{errors.submit}</div>
          )}

          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn-cancel">
              Cancel
            </button>
            <button type="submit" className="btn-submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : (contact ? 'Update Contact' : 'Create Contact')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ContactForm;
