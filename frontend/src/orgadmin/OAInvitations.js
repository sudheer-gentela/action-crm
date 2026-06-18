/* Extracted from OrgAdminView.js — Phase 1 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAInvitations. Rendered by the OrgAdmin shell. */
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';
import { RoleBadge } from '../shared';

export default function OAInvitations() {
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [form, setForm]               = useState({ email: '', role: 'member', message: '' });
  const [sending, setSending]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [showForm, setShowForm]       = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.orgAdmin.getInvitations();
      setInvitations(r.data.invitations);
    } catch { setError('Failed to load invitations'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSend = async () => {
    if (!form.email.trim()) { setError('Email is required'); return; }
    try {
      setSending(true); setError('');
      await apiService.orgAdmin.sendInvitation(form);
      setSuccess(`Invitation sent to ${form.email}`);
      setForm({ email: '', role: 'member', message: '' });
      setShowForm(false);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to send invitation');
    } finally { setSending(false); }
  };

  const handleCancel = async (id, email) => {
    if (!window.confirm(`Cancel invitation to ${email}?`)) return;
    try {
      await apiService.orgAdmin.cancelInvitation(id);
      setSuccess('Invitation cancelled');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch { setError('Failed to cancel invitation'); }
  };

  const STATUS_COLORS = { pending: 'amber', accepted: 'green', cancelled: 'grey', expired: 'red' };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>✉️ Team Invitations</h2>
          <p className="sv-panel-desc">Invite people to join your organisation. Invitations expire after 7 days.</p>
        </div>
        <button className="sv-btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? '✕ Cancel' : '+ Invite Member'}
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Invite form */}
        {showForm && (
          <div className="sv-card oa-invite-form">
            <h3>New Invitation</h3>
            <div className="sa-form-grid">
              <div className="sa-form-field sa-form-field--full">
                <label>Email Address *</label>
                <input
                  autoFocus
                  type="email"
                  placeholder="colleague@company.com"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="sa-form-field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                  <option value="admin">🔑 Admin</option>
                  <option value="member">👤 Member</option>
                  <option value="viewer">👁 Viewer</option>
                </select>
              </div>
              <div className="sa-form-field sa-form-field--full">
                <label>Personal Message (optional)</label>
                <textarea
                  placeholder="Hey, I'd like to invite you to our CRM…"
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  rows={2}
                />
              </div>
            </div>
            <div className="oa-invite-actions">
              <p className="sv-hint">They'll receive an email with a link to join. If they don't have an account, they'll be prompted to create one.</p>
              <button className="sv-btn-primary" onClick={handleSend} disabled={sending}>
                {sending ? '⏳ Sending…' : '📨 Send Invitation'}
              </button>
            </div>
          </div>
        )}

        {/* Invitations list */}
        {loading ? (
          <div className="sv-loading">Loading invitations…</div>
        ) : invitations.length === 0 ? (
          <div className="sv-empty">No invitations sent yet</div>
        ) : (
          <div className="oa-invite-list">
            {invitations.map(inv => (
              <div key={inv.id} className="oa-invite-row">
                <div className="oa-invite-info">
                  <div className="oa-member-name">{inv.email}</div>
                  <div className="oa-member-meta">
                    <RoleBadge role={inv.role} />
                    {' '}· Invited by {inv.invited_by_email || 'admin'}
                    {' '}· {new Date(inv.created_at).toLocaleDateString()}
                    {inv.expires_at && ` · Expires ${new Date(inv.expires_at).toLocaleDateString()}`}
                  </div>
                  {inv.message && <div className="oa-invite-message">"{inv.message}"</div>}
                </div>
                <div className="oa-invite-status">
                  <span className={`sa-badge-status sa-badge-status--${STATUS_COLORS[inv.status] || 'grey'}`}>
                    {inv.status}
                  </span>
                  {inv.status === 'pending' && (
                    <button className="oa-btn-remove" onClick={() => handleCancel(inv.id, inv.email)}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
