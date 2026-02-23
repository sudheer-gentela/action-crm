import React, { useState, useEffect } from 'react';
import './DealForm.css';
import { apiService } from './apiService';

const API_BASE = process.env.REACT_APP_API_URL || '';

// Hardcoded fallback — used only if the API call fails.
// Preserves full backward compatibility during the migration window.
const FALLBACK_STAGES = [
  { key: 'qualified',   name: 'Qualified' },
  { key: 'demo',        name: 'Demo' },
  { key: 'proposal',    name: 'Proposal' },
  { key: 'negotiation', name: 'Negotiation' },
  { key: 'closed_won',  name: 'Closed Won' },
  { key: 'closed_lost', name: 'Closed Lost' },
];

function DealForm({ deal, onSubmit, onClose, accounts }) {
  const [formData, setFormData] = useState({
    name:                '',
    account_id:          '',
    value:               '',
    stage:               'qualified',
    health:              'healthy',
    expected_close_date: '',
    probability:         50,
    notes:               '',
    playbook_id:         ''
  });

  const [errors, setErrors]                     = useState({});
  const [isSubmitting, setIsSubmitting]         = useState(false);
  const [playbooks, setPlaybooks]               = useState([]);
  const [playbooksLoading, setPlaybooksLoading] = useState(true);
  const [stages, setStages]                     = useState(FALLBACK_STAGES);
  const [stagesLoading, setStagesLoading]       = useState(true);

  // Populate form if editing an existing deal
  useEffect(() => {
    if (deal) {
      setFormData({
        name:                deal.name                || '',
        account_id:          deal.account_id          || '',
        value:               deal.value               || '',
        stage:               deal.stage               || 'qualified',
        health:              deal.health              || 'healthy',
        expected_close_date: deal.expected_close_date ? deal.expected_close_date.split('T')[0] : '',
        probability:         deal.probability         || 50,
        notes:               deal.notes               || '',
        playbook_id:         deal.playbook_id         || ''
      });
    }
  }, [deal]);

  // Load active org stages — falls back to FALLBACK_STAGES on error
  useEffect(() => {
    const token = localStorage.getItem('token') || localStorage.getItem('authToken');
    fetch(`${API_BASE}/api/deal-stages/active`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => {
        if (data.stages?.length) {
          setStages(data.stages.map(s => ({ key: s.key, name: s.name, is_terminal: s.is_terminal })));
          // If creating a new deal, default to the first active non-terminal stage
          if (!deal) {
            const firstActive = data.stages.find(s => !s.is_terminal);
            if (firstActive) {
              setFormData(prev => ({ ...prev, stage: firstActive.key }));
            }
          }
        }
      })
      .catch(() => {
        // Silent fallback — FALLBACK_STAGES already set as initial state
        console.warn('DealForm: could not load org stages, using defaults');
      })
      .finally(() => setStagesLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load playbooks for dropdown
  useEffect(() => {
    (async () => {
      try {
        const r = await apiService.playbooks.getAll();
        setPlaybooks(r.data.playbooks || []);
      } catch {
        setPlaybooks([]);
      } finally {
        setPlaybooksLoading(false);
      }
    })();
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: null }));
    }
  };

  const validateForm = () => {
    const newErrors = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Deal name is required';
    }
    if (!formData.account_id) {
      newErrors.account_id = 'Please select an account';
    }
    if (!formData.value || formData.value <= 0) {
      newErrors.value = 'Deal value must be greater than 0';
    }
    if (!formData.expected_close_date) {
      newErrors.expected_close_date = 'Expected close date is required';
    } else {
      const closeDate = new Date(formData.expected_close_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (closeDate < today) {
        newErrors.expected_close_date = 'Close date cannot be in the past';
      }
    }
    if (formData.probability < 0 || formData.probability > 100) {
      newErrors.probability = 'Probability must be between 0 and 100';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    setIsSubmitting(true);
    try {
      const submitData = {
        ...formData,
        value:       parseFloat(formData.value),
        probability: parseInt(formData.probability),
        playbookId:  formData.playbook_id ? parseInt(formData.playbook_id) : null
      };
      await onSubmit(submitData);
    } catch (error) {
      console.error('Error submitting form:', error);
      setErrors({ submit: 'Failed to save deal. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{deal ? 'Edit Deal' : 'Create New Deal'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="deal-form">

          {/* Deal Name */}
          <div className="form-group">
            <label htmlFor="name">
              Deal Name <span className="required">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="e.g., Acme Corp Enterprise Deal"
              className={errors.name ? 'error' : ''}
            />
            {errors.name && <span className="error-message">{errors.name}</span>}
          </div>

          {/* Account Selection */}
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
              <option value="">Select an account...</option>
              {accounts && accounts.map(account => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            {errors.account_id && <span className="error-message">{errors.account_id}</span>}
          </div>

          {/* Deal Value and Probability */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="value">
                Deal Value <span className="required">*</span>
              </label>
              <div className="input-with-prefix">
                <span className="prefix">$</span>
                <input
                  type="number"
                  id="value"
                  name="value"
                  value={formData.value}
                  onChange={handleChange}
                  placeholder="50000"
                  min="0"
                  step="0.01"
                  className={errors.value ? 'error' : ''}
                />
              </div>
              {errors.value && <span className="error-message">{errors.value}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="probability">Probability (%)</label>
              <input
                type="number"
                id="probability"
                name="probability"
                value={formData.probability}
                onChange={handleChange}
                min="0"
                max="100"
                className={errors.probability ? 'error' : ''}
              />
              {errors.probability && <span className="error-message">{errors.probability}</span>}
            </div>
          </div>

          {/* Stage and Health */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="stage">Deal Stage</label>
              <select
                id="stage"
                name="stage"
                value={formData.stage}
                onChange={handleChange}
                disabled={stagesLoading}
              >
                {stages.map(s => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
              {stagesLoading && <span className="field-hint">Loading stages…</span>}
            </div>

            <div className="form-group">
              <label htmlFor="health">Deal Health</label>
              <select
                id="health"
                name="health"
                value={formData.health}
                onChange={handleChange}
              >
                <option value="healthy">✅ Healthy</option>
                <option value="watch">⚠️ Watch</option>
                <option value="risk">🔴 At Risk</option>
              </select>
            </div>
          </div>

          {/* Expected Close Date */}
          <div className="form-group">
            <label htmlFor="expected_close_date">
              Expected Close Date <span className="required">*</span>
            </label>
            <input
              type="date"
              id="expected_close_date"
              name="expected_close_date"
              value={formData.expected_close_date}
              onChange={handleChange}
              className={errors.expected_close_date ? 'error' : ''}
            />
            {errors.expected_close_date && (
              <span className="error-message">{errors.expected_close_date}</span>
            )}
          </div>

          {/* Playbook */}
          <div className="form-group">
            <label htmlFor="playbook_id">
              Sales Playbook
              <span className="field-hint"> — guides AI actions for this deal</span>
            </label>
            <select
              id="playbook_id"
              name="playbook_id"
              value={formData.playbook_id}
              onChange={handleChange}
              disabled={playbooksLoading}
            >
              <option value="">Use org default playbook</option>
              {playbooks.map(pb => (
                <option key={pb.id} value={pb.id}>
                  {pb.is_default ? '★ ' : ''}{pb.name}{pb.type !== 'custom' ? ` (${pb.type})` : ''}
                </option>
              ))}
            </select>
            {playbooksLoading && <span className="field-hint">Loading playbooks...</span>}
          </div>

          {/* Notes */}
          <div className="form-group">
            <label htmlFor="notes">Notes</label>
            <textarea
              id="notes"
              name="notes"
              value={formData.notes}
              onChange={handleChange}
              placeholder="Add any additional notes about this deal..."
              rows="4"
            />
          </div>

          {errors.submit && (
            <div className="error-banner">{errors.submit}</div>
          )}

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : (deal ? 'Update Deal' : 'Create Deal')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default DealForm;
