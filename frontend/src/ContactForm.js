import React, { useState, useEffect } from 'react';
import { apiService, salesforceAPI } from './apiService';
import './ContactForm.css';

function ContactForm({ contact, accounts: initialAccounts, onSubmit, onClose }) {
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

  // Local accounts list — updated when a new account is created inline
  const [accounts, setAccounts] = useState(initialAccounts || []);

  // Inline new-account state
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({ name: '', domain: '', industry: '' });
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [sfLockedFields, setSfLockedFields] = useState([]);

  useEffect(() => {
    salesforceAPI.getLockedFields('contact')
      .then(r => setSfLockedFields(r.data || []))
      .catch(() => {});
  }, []);

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

  // Keep accounts in sync if parent re-renders with new list
  useEffect(() => {
    if (initialAccounts) setAccounts(initialAccounts);
  }, [initialAccounts]);

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

  // ── Inline account creation ────────────────────────────────
  const handleCreateAccount = async () => {
    if (!newAccount.name.trim()) {
      setAccountError('Account name is required');
      return;
    }
    setCreatingAccount(true);
    setAccountError('');
    try {
      const response = await apiService.accounts.create({
        name: newAccount.name.trim(),
        domain: newAccount.domain.trim() || null,
        industry: newAccount.industry.trim() || null,
      });
      const created = response.data.account || response.data;
      // Add to local list and auto-select it
      setAccounts(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setFormData(prev => ({ ...prev, accountId: created.id }));
      setShowNewAccount(false);
      setNewAccount({ name: '', domain: '', industry: '' });
      // Clear accountId validation error if it existed
      if (errors.accountId) {
        setErrors(prev => ({ ...prev, accountId: null }));
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Failed to create account';
      setAccountError(msg);
    } finally {
      setCreatingAccount(false);
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
                {sfLockedFields.includes('email') && <span title="Managed by Salesforce" style={{ marginLeft: 6, fontSize: 11, color: '#0369a1' }}>🔒 SF</span>}
              </label>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                className={errors.email ? 'error' : ''}
                placeholder="contact@company.com"
                disabled={sfLockedFields.includes('email')}
                title={sfLockedFields.includes('email') ? 'Managed by Salesforce' : undefined}
              />
              {errors.email && <span className="error-message">{errors.email}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="phone">
                Phone
                {sfLockedFields.includes('phone') && <span title="Managed by Salesforce" style={{ marginLeft: 6, fontSize: 11, color: '#0369a1' }}>🔒 SF</span>}
              </label>
              <input
                type="tel"
                id="phone"
                name="phone"
                value={formData.phone}
                onChange={handleChange}
                className={errors.phone ? 'error' : ''}
                placeholder="+1-555-123-4567"
                disabled={sfLockedFields.includes('phone')}
                title={sfLockedFields.includes('phone') ? 'Managed by Salesforce' : undefined}
              />
              {errors.phone && <span className="error-message">{errors.phone}</span>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="title">
                Job Title
                {sfLockedFields.includes('title') && <span title="Managed by Salesforce" style={{ marginLeft: 6, fontSize: 11, color: '#0369a1' }}>🔒 SF</span>}
              </label>
              <input
                type="text"
                id="title"
                name="title"
                value={formData.title}
                onChange={handleChange}
                placeholder="VP of Sales"
                disabled={sfLockedFields.includes('title')}
                title={sfLockedFields.includes('title') ? 'Managed by Salesforce' : undefined}
              />
            </div>

            <div className="form-group">
              <label htmlFor="accountId">
                Account <span className="required">*</span>
              </label>
              {!showNewAccount ? (
                <>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      id="accountId"
                      name="accountId"
                      value={formData.accountId}
                      onChange={handleChange}
                      className={errors.accountId ? 'error' : ''}
                      style={{ flex: 1 }}
                    >
                      <option value="">Select account...</option>
                      {accounts.map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowNewAccount(true)}
                      style={{
                        padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6,
                        background: '#f9fafb', cursor: 'pointer', fontSize: 14, color: '#4f46e5',
                        whiteSpace: 'nowrap', fontWeight: 600,
                      }}
                      title="Create a new account"
                    >
                      + New
                    </button>
                  </div>
                  {errors.accountId && <span className="error-message">{errors.accountId}</span>}
                </>
              ) : (
                <div style={{ border: '1px solid #c7d2fe', borderRadius: 8, padding: 12, background: '#eef2ff' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#4338ca', marginBottom: 8 }}>New Account</div>
                  <input
                    type="text"
                    placeholder="Account name *"
                    value={newAccount.name}
                    onChange={e => setNewAccount(prev => ({ ...prev, name: e.target.value }))}
                    style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, marginBottom: 6, fontSize: 13, boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <input
                      type="text"
                      placeholder="Domain (optional)"
                      value={newAccount.domain}
                      onChange={e => setNewAccount(prev => ({ ...prev, domain: e.target.value }))}
                      style={{ flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <input
                      type="text"
                      placeholder="Industry (optional)"
                      value={newAccount.industry}
                      onChange={e => setNewAccount(prev => ({ ...prev, industry: e.target.value }))}
                      style={{ flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                  </div>
                  {accountError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 6 }}>{accountError}</div>}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      onClick={handleCreateAccount}
                      disabled={creatingAccount}
                      style={{
                        padding: '6px 14px', background: '#4f46e5', color: '#fff',
                        border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
                      }}
                    >
                      {creatingAccount ? 'Creating…' : 'Create Account'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowNewAccount(false); setAccountError(''); setNewAccount({ name: '', domain: '', industry: '' }); }}
                      style={{
                        padding: '6px 14px', background: '#f3f4f6', color: '#374151',
                        border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
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
