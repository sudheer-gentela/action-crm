/**
 * ProjectAttachments.js
 *
 * DROP-IN LOCATION: frontend/src/ProjectAttachments.js  (NEW FILE)
 *
 * What happened to every file shared in this project's WhatsApp groups.
 *
 * THIS PANEL EXISTS BECAUSE THE FAILURES WERE INVISIBLE.
 * Capture is automatic and the fallback works, but until now a skipped or
 * failed attachment sat in the database with a 30-day clock and nothing in the
 * product said so. Somebody could put the file back by hand — they just had no
 * way to know they needed to. Nothing here is decorative: every state shown is
 * one a person has to act on, or one that closes the loop.
 *
 * The clock is real. The number is on the WhatsApp Cloud API and has no app
 * inbox, so an attachment nobody recovers before Meta drops it is gone for
 * everyone, permanently.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

/**
 * Multipart upload of a replacement file.
 *
 * Not apiService: axios/fetch must set Content-Type itself for FormData so it
 * can include the multipart boundary. Setting it by hand yields a body the
 * server cannot parse and a misleading "no file received".
 */
async function uploadReplacement(handoverId, messageId, file) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const fd = new FormData();
  fd.append('file', file);
  if (messageId) fd.append('whatsappMessageId', String(messageId));

  const res = await fetch(`${API_BASE}/project-files/${handoverId}/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || res.statusText);
  return body;
}

/** See ProjectFilesPanel.copyToClipboard for why the fallback exists. */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const el = document.createElement('textarea');
    el.value = text; el.setAttribute('readonly', '');
    el.style.position = 'fixed'; el.style.opacity = '0';
    document.body.appendChild(el); el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch { return false; }
}

const errText = (e, fallback) => e?.response?.data?.error?.message || e?.message || fallback;

const TYPE_ICON = { image: '🖼️', video: '🎥', audio: '🎧', document: '📄', sticker: '🏷️' };

const STATE = {
  stored:  { label: 'Saved',            bg: '#dcfce7', fg: '#065f46' },
  pending: { label: 'Saving…',          bg: '#e0f2fe', fg: '#075985' },
  failed:  { label: 'Not saved',        bg: '#fee2e2', fg: '#991b1b' },
  skipped: { label: 'Not saved',        bg: '#fef3c7', fg: '#92400e' },
  expired: { label: 'Gone from WhatsApp', bg: '#f3f4f6', fg: '#6b7280' },
  removed: { label: 'Removed',          bg: '#f3f4f6', fg: '#6b7280' },
};

const S = {
  wrap: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 14, background: '#fff' },
  head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  h4:   { margin: 0, fontSize: 13, fontWeight: 700, color: '#374151' },
  row:  { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0',
          borderBottom: '1px solid #f3f4f6', fontSize: 13 },
  meta: { fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  btn:  { fontSize: 11, padding: '3px 9px', borderRadius: 4, border: '1px solid #d1d5db',
          background: '#fff', color: '#374151', cursor: 'pointer' },
  pill: (s) => ({ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                  background: s.bg, color: s.fg, textTransform: 'uppercase', letterSpacing: 0.3 }),
  err:  { padding: '6px 9px', background: '#fee2e2', color: '#991b1b', borderRadius: 5, fontSize: 12, margin: '8px 0' },
  note: { padding: '6px 9px', background: '#eff6ff', color: '#1e40af', borderRadius: 5, fontSize: 12, margin: '8px 0' },
  warn: { padding: '6px 9px', background: '#fef3c7', color: '#92400e', borderRadius: 5, fontSize: 12, margin: '8px 0' },
  empty:{ fontSize: 12, color: '#9ca3af', margin: '6px 0' },
};

function daysLeft(expiresAt) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86400000);
}

function AttachmentRow({ a, handoverId, busy, onKeep, onRemove, onRetry, onReload, setError }) {
  const [copied, setCopied] = useState(false);
  const state = STATE[a.media_status] || STATE.pending;
  const left  = daysLeft(a.media_expires_at);
  const recoverable = ['failed', 'skipped'].includes(a.media_status);
  const unreviewed  = a.media_status === 'stored' && !a.media_reviewed_at;

  const replace = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try { await uploadReplacement(handoverId, a.id, file); await onReload(); }
    catch (err) { setError(errText(err, 'Could not upload that file.')); }
  };

  return (
    <div style={S.row}>
      <span>{TYPE_ICON[a.message_type] || '📎'}</span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {a.file_name || a.media_filename || a.body || '(attachment)'}
        </div>
        <div style={S.meta}>
          <span style={S.pill(state)}>{state.label}</span>
          {a.from_name && <span>from {a.from_name}</span>}
          {a.sent_at && <span>· {new Date(a.sent_at).toLocaleDateString()}</span>}
          {a.reviewed_by_name && <span>· reviewed by {a.reviewed_by_name}</span>}
          {/* Only worth showing while it is still recoverable — a countdown on
              something already saved is noise. */}
          {recoverable && left !== null && (
            <span style={{ color: left <= 5 ? '#991b1b' : '#6b7280' }}>
              · {left === 0 ? 'expires today' : `${left} day${left === 1 ? '' : 's'} left to recover`}
            </span>
          )}
        </div>
        {a.media_error && recoverable && (
          <div style={{ ...S.meta, color: '#991b1b' }}>{a.media_error}</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {a.web_url && (
          <a href={a.web_url} target="_blank" rel="noopener noreferrer"
             style={{ ...S.btn, textDecoration: 'none' }}>Open ↗</a>
        )}
        {a.web_url && (
          <button style={S.btn}
            title="Copy a link to this file. Whoever you send it to still needs access in the provider."
            onClick={async () => {
              const ok = await copyToClipboard(a.web_url);
              if (!ok) { setError('Your browser blocked the copy. Use Open and copy from the address bar.'); return; }
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>
            {copied ? '✓ Copied' : '🔗 Copy link'}
          </button>
        )}
        {unreviewed && (
          <button style={S.btn} disabled={busy} onClick={() => onKeep(a.id)}>Keep</button>
        )}
        {a.media_status === 'stored' && (
          <button style={S.btn} disabled={busy} onClick={() => onRemove(a)}
            title="Delete it from your cloud storage">Remove</button>
        )}
        {recoverable && (
          <button style={S.btn} disabled={busy} onClick={() => onRetry(a.id)}>Try again</button>
        )}
        {/* The human fallback: somebody in the group still has this on their
            phone, and for 'expired' it is the ONLY way back. */}
        {(recoverable || a.media_status === 'expired') && (
          <label style={{ ...S.btn, cursor: 'pointer' }}
                 title="Someone in the group still has this file — upload it here">
            ⬆ Upload it
            <input type="file" onChange={replace} style={{ display: 'none' }} />
          </label>
        )}
      </div>
    </div>
  );
}

export default function ProjectAttachments({ handoverId }) {
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [notice,  setNotice]  = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!handoverId) return;
    setLoading(true); setError('');
    try {
      const r = await apiService.whatsappMedia.forProject(handoverId);
      setItems(r.data.attachments || []);
    } catch (e) { setError(errText(e, 'Could not load attachments.')); }
    finally { setLoading(false); }
  }, [handoverId]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn, okMsg) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); if (okMsg) setNotice(okMsg); await load(); }
    catch (e) { setError(errText(e, 'That did not work.')); }
    finally { setBusy(false); }
  };

  const keep   = (id) => act(() => apiService.whatsappMedia.keep(id));
  const retry  = (id) => act(() => apiService.whatsappMedia.retry(id), 'Tried again.');
  const remove = (a) => {
    if (!window.confirm(
      `Remove "${a.file_name || 'this attachment'}" from your cloud storage?\n\n`
      + 'The file is deleted from the project folder. WhatsApp will still have it '
      + 'for a while, so it can be recovered until then.')) return;
    return act(() => apiService.whatsappMedia.remove(a.id), 'Removed from storage.');
  };

  if (loading) return null;                 // nothing to say yet
  if (!items.length) return null;           // no attachments — do not add an empty card

  const needsAction = items.filter(a => ['failed', 'skipped', 'expired'].includes(a.media_status));
  const unreviewed  = items.filter(a => a.media_status === 'stored' && !a.media_reviewed_at);
  const rest        = items.filter(a => !needsAction.includes(a) && !unreviewed.includes(a));
  const shown       = showAll ? [...needsAction, ...unreviewed, ...rest] : [...needsAction, ...unreviewed];

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h4 style={S.h4}>
          📎 Shared files
          <span style={{ fontWeight: 400, color: '#9ca3af' }}> · {items.length}</span>
        </h4>
        {rest.length > 0 && (
          <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Show only what needs attention' : `Show all (${rest.length} saved)`}
          </button>
        )}
      </div>

      {error  && <div style={S.err}>⚠️ {error}</div>}
      {notice && <div style={S.note}>ℹ️ {notice}</div>}

      {needsAction.length > 0 && (
        <div style={S.warn}>
          {needsAction.length} file{needsAction.length === 1 ? '' : 's'} not saved to your storage.
          WhatsApp deletes shared files after about 30 days and this number has no app inbox, so
          once that passes they cannot be recovered by anyone — but somebody in the group still
          has them until then.
        </div>
      )}

      {!shown.length && (
        <p style={S.empty}>Everything shared here has been saved to the project folder.</p>
      )}

      {shown.map(a => (
        <AttachmentRow key={a.id} a={a} handoverId={handoverId} busy={busy}
          onKeep={keep} onRemove={remove} onRetry={retry}
          onReload={load} setError={setError} />
      ))}
    </div>
  );
}
