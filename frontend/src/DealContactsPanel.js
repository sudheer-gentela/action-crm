import React, { useState, useEffect, useCallback } from 'react';
import './DealContactsPanel.css';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

// Role badge colours — keyed off common deal_contacts role values
const ROLE_COLORS = {
  champion:          { bg: '#fdf4ff', color: '#7c3aed', border: '#c4b5fd' },
  decision_maker:    { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' },
  economic_buyer:    { bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
  influencer:        { bg: '#fff7ed', color: '#c2410c', border: '#fdba74' },
  end_user:          { bg: '#fefce8', color: '#a16207', border: '#fde047' },
  blocker:           { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
};
const DEFAULT_ROLE_COLOR = { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' };

// Common role suggestions for the free-text role field
const ROLE_SUGGESTIONS = [
  'Champion',
  'Decision Maker',
  'Economic Buyer',
  'Influencer',
  'End User',
  'Blocker',
  'Technical Evaluator',
  'Legal / Procurement',
];

function RoleBadge({ role }) {
  const key = (role || '').toLowerCase().replace(/[\s/]+/g, '_');
  const colors = ROLE_COLORS[key] || DEFAULT_ROLE_COLOR;
  return (
    <span
      className="dcp-role-badge"
      style={{ background: colors.bg, color: colors.color, borderColor: colors.border }}
    >
      {role}
    </span>
  );
}

function ContactAvatar({ firstName, lastName }) {
  const initials = [firstName?.[0], lastName?.[0]]
    .filter(Boolean)
    .join('')
    .toUpperCase();
  return <div className="dcp-avatar">{initials || '?'}</div>;
}

function navigateToContact(contactId) {
  window.dispatchEvent(
    new CustomEvent('navigate', { detail: { tab: 'contacts', contactId } })
  );
}

export default function DealContactsPanel({ deal }) {
  const [linked,         setLinked]         = useState([]);
  const [eligible,       setEligible]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState('');
  const [showAddForm,    setShowAddForm]    = useState(false);
  const [addContactId,   setAddContactId]   = useState('');
  const [addRole,        setAddRole]        = useState('');
  const [adding,         setAdding]         = useState(false);
  const [addError,       setAddError]       = useState('');
  // Inline role editing: tracks { contactId, value } while editing
  const [editingRole,    setEditingRole]    = useState(null);

  const fetchContacts = useCallback(async () => {
    if (!deal?.id) return;
    try {
      const [linkedRes, eligibleRes] = await Promise.all([
        apiFetch(`/deal-contacts/${deal.id}/contacts`),
        apiFetch(`/deal-contacts/${deal.id}/contacts/eligible`),
      ]);
      setLinked(linkedRes.contacts   || []);
      setEligible(eligibleRes.contacts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { fetchContacts(); }, [fetchContacts]);

  async function handleAdd() {
    if (!addContactId) { setAddError('Please select a contact'); return; }
    setAdding(true);
    setAddError('');
    try {
      const res = await apiFetch(`/deal-contacts/${deal.id}/contacts`, {
        method: 'POST',
        body: JSON.stringify({
          contactId: parseInt(addContactId),
          role:      addRole.trim() || null,
        }),
      });
      setLinked(prev => [...prev, res.contact]);
      setEligible(prev => prev.filter(c => c.id !== parseInt(addContactId)));
      setAddContactId('');
      setAddRole('');
      setShowAddForm(false);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(contact) {
    const name = `${contact.firstName} ${contact.lastName}`.trim();
    if (!window.confirm(`Remove ${name} from this deal?`)) return;
    try {
      await apiFetch(`/deal-contacts/${deal.id}/contacts/${contact.contactId}`, {
        method: 'DELETE',
      });
      setLinked(prev => prev.filter(c => c.contactId !== contact.contactId));
      setEligible(prev => [...prev, {
        id:          contact.contactId,
        firstName:   contact.firstName,
        lastName:    contact.lastName,
        email:       contact.email,
        title:       contact.title,
        roleType:    contact.roleType,
        accountName: contact.accountName,
      }]);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRoleSave(contact, newRole) {
    try {
      await apiFetch(`/deal-contacts/${deal.id}/contacts/${contact.contactId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole.trim() || null }),
      });
      setLinked(prev => prev.map(c =>
        c.contactId === contact.contactId
          ? { ...c, dealRole: newRole.trim() || null }
          : c
      ));
    } catch (err) {
      setError(err.message);
    } finally {
      setEditingRole(null);
    }
  }

  if (loading) {
    return (
      <div className="dcp-loading">
        <span className="dcp-spinner" /> Loading contacts…
      </div>
    );
  }

  return (
    <div className="dcp-root">

      {/* Header */}
      <div className="dcp-header">
        <span className="dcp-count">
          {linked.length === 0
            ? 'No contacts linked yet'
            : `${linked.length} contact${linked.length !== 1 ? 's' : ''}`}
        </span>
        <button
          className="dcp-btn dcp-btn--add"
          onClick={() => { setShowAddForm(v => !v); setAddError(''); }}
        >
          {showAddForm ? 'Cancel' : '+ Add Contact'}
        </button>
      </div>

      {error && <div className="dcp-error">⚠️ {error}</div>}

      {/* Add contact form */}
      {showAddForm && (
        <div className="dcp-add-form">
          <div className="dcp-add-form__row">
            <select
              className="dcp-select"
              value={addContactId}
              onChange={e => setAddContactId(e.target.value)}
            >
              <option value="">Select contact…</option>
              {eligible.map(c => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                  {c.title ? ` — ${c.title}` : ''}
                  {c.accountName ? ` (${c.accountName})` : ''}
                </option>
              ))}
            </select>

            {/* Role — free text with datalist suggestions */}
            <input
              className="dcp-input"
              list="dcp-role-suggestions"
              placeholder="Role on this deal (optional)…"
              value={addRole}
              onChange={e => setAddRole(e.target.value)}
            />
            <datalist id="dcp-role-suggestions">
              {ROLE_SUGGESTIONS.map(r => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>

          {addError && <div className="dcp-add-form__error">{addError}</div>}

          <div className="dcp-add-form__actions">
            <button
              className="dcp-btn dcp-btn--save"
              onClick={handleAdd}
              disabled={adding}
            >
              {adding ? '…' : 'Link Contact'}
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {linked.length === 0 && !showAddForm && (
        <p className="dcp-empty">
          Link contacts to this deal to track relationships and navigate to their profiles.
        </p>
      )}

      {/* Linked contacts list */}
      <div className="dcp-contacts">
        {linked.map(contact => {
          const isEditingThisRole = editingRole?.contactId === contact.contactId;

          return (
            <div key={contact.contactId} className="dcp-contact">
              <ContactAvatar firstName={contact.firstName} lastName={contact.lastName} />

              {/* Info — clicking navigates to the contact */}
              <div
                className="dcp-contact__info dcp-contact__info--clickable"
                onClick={() => navigateToContact(contact.contactId)}
                title="Open contact"
              >
                <div className="dcp-contact__name">
                  {contact.firstName} {contact.lastName}
                  <span className="dcp-contact__arrow">→</span>
                </div>
                <div className="dcp-contact__meta">
                  {[contact.title, contact.accountName].filter(Boolean).join(' · ')}
                </div>
              </div>

              {/* Role — click badge/placeholder to edit inline */}
              <div className="dcp-contact__role">
                {isEditingThisRole ? (
                  <input
                    className="dcp-role-input"
                    list="dcp-role-suggestions"
                    autoFocus
                    value={editingRole.value}
                    onChange={e => setEditingRole(r => ({ ...r, value: e.target.value }))}
                    onBlur={() => handleRoleSave(contact, editingRole.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRoleSave(contact, editingRole.value);
                      if (e.key === 'Escape') setEditingRole(null);
                    }}
                    placeholder="Role…"
                  />
                ) : contact.dealRole ? (
                  <RoleBadge
                    role={contact.dealRole}
                    onClick={() => setEditingRole({ contactId: contact.contactId, value: contact.dealRole })}
                  />
                ) : (
                  <button
                    className="dcp-btn dcp-btn--set-role"
                    onClick={() => setEditingRole({ contactId: contact.contactId, value: '' })}
                    title="Set role"
                  >
                    + role
                  </button>
                )}
              </div>

              {/* Remove */}
              <button
                className="dcp-btn dcp-btn--remove"
                onClick={() => handleRemove(contact)}
                title="Remove from deal"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
