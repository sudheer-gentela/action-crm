import React, { useState, useEffect } from 'react';
import './AccountForm.css';

function AccountForm({ account, onSubmit, onClose }) {
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    industry: '',
    size: '',
    location: '',
    description: ''
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Populate form if editing
  useEffect(() => {
    if (account) {
      setFormData({
        name: account.name || '',
        domain: account.domain || '',
        industry: account.industry || '',
        size: account.size || '',
        location: account.location || '',
        description: account.description || ''
      });
    }
  }, [account]);

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

    if (!formData.name.trim()) {
      newErrors.name = 'Company name is required';
    }

    if (formData.domain && !formData.domain.match(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/)) {
      newErrors.domain = 'Please enter a valid domain (e.g., company.com)';
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
      setErrors({ submit: 'Failed to save account. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{account ? 'Edit Account' : 'Create New Account'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="account-form">
          {/* Company Name */}
          <div className="form-group">
            <label htmlFor="name">
              Company Name <span className="required">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="e.g., Acme Corporation"
              className={errors.name ? 'error' : ''}
            />
            {errors.name && <span className="error-message">{errors.name}</span>}
          </div>

          {/* Domain and Industry */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="domain">Website Domain</label>
              <input
                type="text"
                id="domain"
                name="domain"
                value={formData.domain}
                onChange={handleChange}
                placeholder="acmecorp.com"
                className={errors.domain ? 'error' : ''}
              />
              {errors.domain && <span className="error-message">{errors.domain}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="industry">Industry</label>
              <select
                id="industry"
                name="industry"
                value={formData.industry}
                onChange={handleChange}
              >
                <option value="">Select industry...</option>
                <option value="Technology">Technology</option>
                <option value="SaaS">SaaS</option>
                <option value="Manufacturing">Manufacturing</option>
                <option value="Healthcare">Healthcare</option>
                <option value="Finance">Finance</option>
                <option value="Retail">Retail</option>
                <option value="Education">Education</option>
                <option value="Construction">Construction</option>
                <option value="Real Estate">Real Estate</option>
                <option value="Professional Services">Professional Services</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          {/* Size and Location */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="size">Company Size</label>
              <select
                id="size"
                name="size"
                value={formData.size}
                onChange={handleChange}
              >
                <option value="">Select size...</option>
                <option value="1-10">1-10 employees</option>
                <option value="11-50">11-50 employees</option>
                <option value="51-200">51-200 employees</option>
                <option value="201-500">201-500 employees</option>
                <option value="501-1000">501-1000 employees</option>
                <option value="1001-5000">1001-5000 employees</option>
                <option value="5001+">5001+ employees</option>
              </select>
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
          </div>

          {/* Description */}
          <div className="form-group">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="Brief description of the company..."
              rows="4"
            />
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
              {isSubmitting ? 'Saving...' : (account ? 'Update Account' : 'Create Account')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AccountForm;
