import React, { useState, useEffect } from 'react';
import './ContactForm.css';

function ContactForm({ contact, accounts, onSubmit, onClose }) {
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    title: '',
    account_id: '',
    role_type: '',
    engagement_level: 'medium'
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Populate form if editing
  useEffect(() => {
    if (contact) {
      setFormData({
        first_name: contact.first_name || '',
        last_name: contact.last_name || '',
        email: contact.email || '',
        phone: contact.phone || '',
        title: contact.title || '',
        account_id: contact.account_id || '',
        role_type: contact.role_type || '',
        engagement_level: contact.engagement_level || 'medium'
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

    if (!formData.first_name.trim()) {
      newErrors.first_name = 'First name is required';
    }

    if (!formData.last_name.trim()) {
      newErrors.last_name = 'Last name is required';
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!formData.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (formData.phone && !formData.phone.match(/^[\d\s\-\+\(\)]+$/)) {
      newErrors.phone = 'Please enter a valid phone number';
    }

    if (!formData.account_id) {
      newErrors.account_id = 'Please select an account';
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
          <h2>{contact ? 'Edit Contact' : 'Create New Contact'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="contact-form">
          {/* Name Fields */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="first_name">
                First Name <span className="required">*</span>
              </label>
              <input
                type="text"
                id="first_name"
                name="first_name"
                value={formData.first_name}
                onChange={handleChange}
                placeholder="John"
                className={errors.first_name ? 'error' : ''}
              />
              {errors.first_name && <span className="error-message">{errors.first_name}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="last_name">
                Last Name <span className="required">*</span>
              </label>
              <input
                type="text"
                id="last_name"
                name="last_name"
                value={formData.last_name}
                onChange={handleChange}
                placeholder="Doe"
                className={errors.last_name ? 'error' : ''}
              />
              {errors.last_name && <span className="error-message">{errors.last_name}</span>}
            </div>
          </div>

          {/* Email and Phone */}
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
                placeholder="john.doe@company.com"
                className={errors.email ? 'error' : ''}
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
                placeholder="+1-555-123-4567"
                className={errors.phone ? 'error' : ''}
              />
              {errors.phone && <span className="error-message">{errors.phone}</span>}
            </div>
          </div>

          {/* Title and Account */}
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
              <label htmlFor="account_id">
                Account <span className="required">*</span>
              </label>
              <select
                id="account_id"
                name="account_id"
                value={formData.account_id}
                onChange={handleChange}
                className={errors.account_id ? 'error' : ''}
              >
                <option value="">Select account...</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
              {errors.account_id && <span className="error-message">{errors.account_id}</span>}
            </div>
          </div>

          {/* Role Type and Engagement */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="role_type">Role Type</label>
              <select
                id="role_type"
                name="role_type"
                value={formData.role_type}
                onChange={handleChange}
              >
                <option value="">Select role...</option>
                <option value="decision_maker">Decision Maker</option>
                <option value="influencer">Influencer</option>
                <option value="champion">Champion</option>
                <option value="technical">Technical Evaluator</option>
                <option value="end_user">End User</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="engagement_level">Engagement Level</label>
              <select
                id="engagement_level"
                name="engagement_level"
                value={formData.engagement_level}
                onChange={handleChange}
              >
                <option value="high">High - Very Engaged</option>
                <option value="medium">Medium - Moderately Engaged</option>
                <option value="low">Low - Minimal Engagement</option>
              </select>
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
              {isSubmitting ? 'Saving...' : (contact ? 'Update Contact' : 'Create Contact')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ContactForm;
