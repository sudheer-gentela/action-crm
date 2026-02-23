import React, { useState, useEffect, useCallback } from 'react';
import './DealEmailHistory.css';

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

function formatDate(iso) {
  if (!iso) return '';
  const d    = new Date(iso);
  const now  = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff < 7)  return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Group emails into threads by conversation_id
function groupIntoThreads(emails) {
  const threads  = new Map();
  const noConvId = [];

  emails.forEach(email => {
    if (email.conversationId) {
      if (!threads.has(email.conversationId)) {
        threads.set(email.conversationId, []);
      }
      threads.get(email.conversationId).push(email);
    } else {
      noConvId.push([email]);
    }
  });

  // Sort each thread newest first, then sort threads by latest email
  const threadArrays = [...threads.values(), ...noConvId];
  threadArrays.sort((a, b) => new Date(b[0].sentAt) - new Date(a[0].sentAt));

  return threadArrays;
}

// ── Email Thread Row ──────────────────────────────────────────────────────────
function EmailThread({ thread }) {
  const [expanded, setExpanded] = useState(false);
  const latest = thread[0];

  const participants = [...new Set(
    thread.map(e => e.contact?.name || e.fromAddress || e.sender?.name).filter(Boolean)
  )].join(', ');

  return (
    <div className={`deh-thread ${expanded ? 'deh-thread--expanded' : ''}`}>
      {/* Thread summary row — always visible */}
      <div
        className="deh-thread__summary"
        onClick={() => setExpanded(v => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && setExpanded(v => !v)}
      >
        <span className="deh-thread__dir">
          {latest.direction === 'sent' ? '📤' : '📥'}
        </span>
        <div className="deh-thread__meta">
          <div className="deh-thread__subject">
            {latest.subject || '(No subject)'}
            {thread.length > 1 && (
              <span className="deh-thread__count">{thread.length}</span>
            )}
          </div>
          <div className="deh-thread__participants">
            {participants || latest.fromAddress}
          </div>
        </div>
        <div className="deh-thread__right">
          <span className="deh-thread__date">{formatDate(latest.sentAt)}</span>
          <span className="deh-thread__chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded: show all emails in thread */}
      {expanded && (
        <div className="deh-thread__emails">
          {thread.map(email => (
            <div key={email.id} className="deh-email">
              <div className="deh-email__header">
                <div className="deh-email__from">
                  <span className="deh-email__dir-icon">
                    {email.direction === 'sent' ? '📤' : '📥'}
                  </span>
                  <strong>
                    {email.direction === 'sent'
                      ? `To: ${email.toAddress}`
                      : `From: ${email.contact?.name || email.fromAddress}`}
                  </strong>
                </div>
                <span className="deh-email__date">
                  {new Date(email.sentAt).toLocaleString('en-US', {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="deh-email__body">
                {email.bodyPreview}
                {email.body && (email.body.replace(/<[^>]+>/g, '').length > 200) && (
                  <span className="deh-email__truncated">…</span>
                )}
              </div>
              {email.tagSource && (
                <div className="deh-email__tag-badge">
                  {email.tagSource === 'manual' ? '🏷️ Manually tagged' : '🔗 Auto-linked'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Untagged Email Tagging Modal ──────────────────────────────────────────────
function TagEmailModal({ deal, onTagged, onClose }) {
  const [emails,   setEmails]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [tagging,  setTagging]  = useState(null);  // email id being tagged
  const [snoozed,  setSnoozed]  = useState(null);  // contact id being snoozed
  const [error,    setError]    = useState('');

  useEffect(() => {
    const accountId = deal.account?.id || deal.account_id;
    const query     = accountId ? `?accountId=${accountId}` : '';
    apiFetch(`/emails/untagged${query}`)
      .then(r => setEmails(r.emails || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [deal]);

  async function handleTag(email) {
    setTagging(email.id);
    setError('');
    try {
      await apiFetch(`/emails/${email.id}/tag`, {
        method: 'PATCH',
        body: JSON.stringify({ dealId: deal.id }),
      });
      setEmails(prev => prev.filter(e => e.id !== email.id));
      onTagged();
    } catch (e) {
      setError(e.message);
    } finally {
      setTagging(null);
    }
  }

  async function handleSnoozeContact(contact) {
    setSnoozed(contact.id);
    setError('');
    try {
      await apiFetch(`/contacts/${contact.id}/snooze-email`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Not relevant to this deal' }),
      });
      // Remove all emails from this contact from the list
      setEmails(prev => prev.filter(e => e.contact?.id !== contact.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setSnoozed(null);
    }
  }

  return (
    <div className="deh-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="deh-modal">
        <div className="deh-modal__header">
          <div>
            <h3>🏷️ Tag Emails to this Deal</h3>
            <p className="deh-modal__subtitle">
              Emails from contacts on this account that haven't been linked to a deal yet.
            </p>
          </div>
          <button className="deh-modal__close" onClick={onClose}>×</button>
        </div>

        {error && <div className="deh-modal__error">⚠️ {error}</div>}

        <div className="deh-modal__body">
          {loading && <div className="deh-modal__loading">Loading untagged emails…</div>}

          {!loading && emails.length === 0 && (
            <div className="deh-modal__empty">
              <p>No untagged emails found for this account.</p>
              <p className="deh-modal__empty-hint">
                Emails are automatically linked when senders match known contacts.
                If emails aren't appearing here, check that the contact is in your CRM.
              </p>
            </div>
          )}

          {!loading && emails.length > 0 && (
            <div className="deh-modal__emails">
              {emails.map(email => (
                <div key={email.id} className="deh-modal__email-row">
                  <div className="deh-modal__email-info">
                    <div className="deh-modal__email-subject">
                      {email.direction === 'sent' ? '📤' : '📥'} {email.subject || '(No subject)'}
                    </div>
                    <div className="deh-modal__email-meta">
                      {email.contact?.name || email.fromAddress} ·{' '}
                      {email.contact?.accountName && <span>{email.contact.accountName} · </span>}
                      {formatDate(email.sentAt)}
                    </div>
                    {email.bodyPreview && (
                      <div className="deh-modal__email-preview">{email.bodyPreview}</div>
                    )}
                  </div>
                  <div className="deh-modal__email-actions">
                    <button
                      className="deh-btn deh-btn--tag"
                      onClick={() => handleTag(email)}
                      disabled={tagging === email.id}
                    >
                      {tagging === email.id ? '…' : '🏷️ Tag to Deal'}
                    </button>
                    {email.contact && (
                      <button
                        className="deh-btn deh-btn--snooze"
                        onClick={() => handleSnoozeContact(email.contact)}
                        disabled={snoozed === email.contact.id}
                        title={`Stop showing emails from ${email.contact.name}`}
                      >
                        {snoozed === email.contact.id ? '…' : '😴 Ignore Contact'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Snoozed Contacts Section ──────────────────────────────────────────────────
function SnoozedContacts({ dealId, refreshKey }) {
  const [contacts, setContacts]     = useState([]);
  const [expanded, setExpanded]     = useState(false);
  const [unsnoozed, setUnsnoozed]   = useState(null);

  useEffect(() => {
    apiFetch(`/emails/deal/${dealId}/snoozed-contacts`)
      .then(r => setContacts(r.contacts || []))
      .catch(() => {});
  }, [dealId, refreshKey]);

  async function handleUnsnooze(contact) {
    setUnsnoozed(contact.id);
    try {
      await apiFetch(`/contacts/${contact.id}/unsnooze-email`, { method: 'POST' });
      setContacts(prev => prev.filter(c => c.id !== contact.id));
    } catch (e) {
      console.error('Unsnooze error:', e);
    } finally {
      setUnsnoozed(null);
    }
  }

  if (contacts.length === 0) return null;

  return (
    <div className="deh-snoozed">
      <button
        className="deh-snoozed__toggle"
        onClick={() => setExpanded(v => !v)}
      >
        😴 Snoozed Contacts ({contacts.length})
        <span className="deh-snoozed__chevron">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="deh-snoozed__list">
          {contacts.map(c => (
            <div key={c.id} className="deh-snoozed__row">
              <div className="deh-snoozed__info">
                <span className="deh-snoozed__name">{c.name}</span>
                <span className="deh-snoozed__email">{c.email}</span>
                {c.snoozeReason && (
                  <span className="deh-snoozed__reason">"{c.snoozeReason}"</span>
                )}
              </div>
              <button
                className="deh-btn deh-btn--unsnooze"
                onClick={() => handleUnsnooze(c)}
                disabled={unsnoozed === c.id}
              >
                {unsnoozed === c.id ? '…' : '↑ Unsnooze'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main DealEmailHistory ─────────────────────────────────────────────────────
export default function DealEmailHistory({ deal }) {
  const [emails,       setEmails]       = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [showTagModal, setShowTagModal] = useState(false);
  const [refreshKey,   setRefreshKey]   = useState(0);

  const fetchEmails = useCallback(async () => {
    if (!deal?.id) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/emails/deal/${deal.id}`);
      setEmails(data.emails || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { fetchEmails(); }, [fetchEmails]);

  const threads = groupIntoThreads(emails);

  function handleTagged() {
    // Refresh emails and snoozed contacts after tagging
    fetchEmails();
    setRefreshKey(k => k + 1);
  }

  return (
    <div className="deh-root">

      {/* Header */}
      <div className="deh-header">
        <span className="deh-count">
          {loading ? '' : `${emails.length} email${emails.length !== 1 ? 's' : ''} · ${threads.length} thread${threads.length !== 1 ? 's' : ''}`}
        </span>
        <div className="deh-header__actions">
          <button
            className="deh-btn deh-btn--tag-open"
            onClick={() => setShowTagModal(true)}
            title="Tag unlinked emails to this deal"
          >
            🏷️ Tag Emails
          </button>
          <button
            className="deh-btn deh-btn--refresh"
            onClick={fetchEmails}
            title="Refresh"
          >
            🔄
          </button>
        </div>
      </div>

      {error && <div className="deh-error">⚠️ {error}</div>}

      {/* Snoozed contacts */}
      <SnoozedContacts dealId={deal.id} refreshKey={refreshKey} />

      {/* Email threads */}
      {loading && (
        <div className="deh-loading">Loading email history…</div>
      )}

      {!loading && threads.length === 0 && (
        <div className="deh-empty">
          <p>No emails linked to this deal yet.</p>
          <p className="deh-empty__hint">
            Emails from contacts on this account are automatically linked when synced.
            Use <strong>Tag Emails</strong> to manually link existing emails.
          </p>
        </div>
      )}

      {!loading && threads.length > 0 && (
        <div className="deh-threads">
          {threads.map((thread, i) => (
            <EmailThread key={thread[0].id + '_' + i} thread={thread} />
          ))}
        </div>
      )}

      {/* Tag email modal */}
      {showTagModal && (
        <TagEmailModal
          deal={deal}
          onTagged={handleTagged}
          onClose={() => setShowTagModal(false)}
        />
      )}
    </div>
  );
}
