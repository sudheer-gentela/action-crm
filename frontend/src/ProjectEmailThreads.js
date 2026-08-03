/**
 * ProjectEmailThreads.js
 *
 * DROP-IN LOCATION: frontend/src/ProjectEmailThreads.js  (NEW FILE)
 *
 * Email conversations filed to a project, and the flow for filing one.
 *
 * THREAD-LEVEL, NOT MESSAGE-LEVEL. Filing a conversation links every message on
 * it, in every colleague's mailbox, and every message that arrives on it later.
 * Tagging a single row would tag only the tagger's copy and leave everyone
 * else's untagged — which is what made per-message tagging useless for a team.
 *
 * The Communications tab still renders the messages themselves; this manages
 * which conversations belong here. Deliberately a separate concern: one place
 * decides what is on the project, another shows the timeline.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const S = {
  wrap:  { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 14, background: '#fff' },
  head:  { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  h4:    { margin: 0, fontSize: 13, color: '#374151', fontWeight: 700 },
  row:   { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
           borderBottom: '1px solid #f3f4f6', fontSize: 13 },
  meta:  { fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, flexWrap: 'wrap' },
  btn:   { fontSize: 11, padding: '3px 9px', borderRadius: 4, border: '1px solid #d1d5db',
           background: '#fff', color: '#374151', cursor: 'pointer' },
  pri:   { fontSize: 12, padding: '5px 11px', borderRadius: 4, border: 'none',
           background: '#0369a1', color: '#fff', cursor: 'pointer' },
  err:   { padding: '6px 9px', background: '#fee2e2', color: '#991b1b',
           borderRadius: 5, fontSize: 12, margin: '8px 0' },
  note:  { padding: '6px 9px', background: '#eff6ff', color: '#1e40af',
           borderRadius: 5, fontSize: 12, margin: '8px 0' },
  empty: { fontSize: 12, color: '#9ca3af', margin: '6px 0' },
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Pick an untagged conversation to file ────────────────────────────────────

function ThreadPicker({ handoverId, accountId, onFiled, onClose }) {
  const [emails,  setEmails]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(null);
  const [err,     setErr]     = useState('');
  const [q,       setQ]       = useState('');

  useEffect(() => {
    apiService.projectEmails.untagged(accountId)
      .then(r => setEmails(r.data.emails || []))
      .catch(e => setErr(errText(e, 'Could not load untagged email.')))
      .finally(() => setLoading(false));
  }, [accountId]);

  const file = async (email) => {
    setBusy(email.id); setErr('');
    try {
      const r = await apiService.projectEmails.tagThread(handoverId, { emailId: email.id });
      await onFiled(r.data);
      // Drop every message on that conversation from the picker — the whole
      // thread has just been filed, not only the row that was clicked.
      setEmails(prev => prev.filter(e =>
        e.conversationId ? e.conversationId !== email.conversationId : e.id !== email.id));
    } catch (e) { setErr(errText(e, 'Could not file this conversation.')); }
    finally { setBusy(null); }
  };

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? emails.filter(e => `${e.subject || ''} ${e.fromAddress || ''}`.toLowerCase().includes(needle))
    : emails;

  return (
    <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search subject or sender…"
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', flex: 1 }} />
        <button onClick={onClose} style={S.btn}>Close</button>
      </div>

      {err && <div style={S.err}>{err}</div>}
      {loading && <div style={S.empty}>Loading…</div>}
      {!loading && !shown.length && (
        <div style={S.empty}>
          No untagged email{accountId ? ' for this account' : ''}. Mail already tagged to the
          deal shows in the timeline below without being filed here.
        </div>
      )}

      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {shown.map(e => (
          <div key={e.id} style={S.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.subject || '(no subject)'}
              </div>
              <div style={S.meta}>
                <span>{e.fromAddress || 'unknown sender'}</span>
                <span>· {fmtDate(e.sentAt)}</span>
                {e.contact?.accountName && <span>· {e.contact.accountName}</span>}
                {!e.conversationId && <span>· single message (no thread id)</span>}
              </div>
            </div>
            <button style={S.btn} disabled={busy === e.id} onClick={() => file(e)}>
              {busy === e.id ? '…' : 'File thread'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function ProjectEmailThreads({ handoverId, accountId, onChanged }) {
  const [threads, setThreads] = useState([]);
  const [canFile, setCanFile] = useState(false);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState('');
  const [note,    setNote]    = useState('');

  const load = useCallback(async () => {
    if (!handoverId) return;
    setLoading(true); setErr('');
    try {
      const r = await apiService.projectEmails.threads(handoverId);
      setThreads(r.data.threads || []);
      setCanFile(!!r.data.canFile);
    } catch (e) { setErr(errText(e, 'Could not load filed conversations.')); }
    finally { setLoading(false); }
  }, [handoverId]);

  useEffect(() => { load(); }, [load]);

  const afterFile = async (result) => {
    setNote(
      result?.threadless
        ? 'That message had no conversation id from the provider, so it was filed on its own.'
        : `Filed — ${result?.messagesLinked || 0} message${result?.messagesLinked === 1 ? '' : 's'} `
          + 'now on this project, including every colleague\u2019s copy. New replies file themselves.'
        + (result?.movedFrom ? ` Moved from "${result.movedFrom}".` : '')
    );
    await load();
    if (onChanged) await onChanged();
  };

  const unfile = async (t) => {
    if (!window.confirm(
      `Remove "${t.subject || 'this conversation'}" from the project?\n\n`
      + 'Nothing is deleted from anyone\u2019s mailbox. Messages tagged individually stay.')) return;
    setErr(''); setNote('');
    try {
      const r = await apiService.projectEmails.untagThread(handoverId, t.conversation_id);
      setNote(`Removed — ${r.data.messagesReleased} message(s) released.`);
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setErr(errText(e, 'Could not remove.')); }
  };

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h4 style={S.h4}>
          ✉️ Email threads on this project
          <span style={{ fontWeight: 400, color: '#9ca3af' }}> · {threads.length}</span>
        </h4>
        {canFile && (
          <button style={{ ...S.pri, marginLeft: 'auto' }} onClick={() => { setPicking(p => !p); setNote(''); }}>
            {picking ? 'Done' : '+ File a thread'}
          </button>
        )}
      </div>

      {err  && <div style={S.err}>⚠️ {err}</div>}
      {note && <div style={S.note}>ℹ️ {note}</div>}

      {picking && (
        <ThreadPicker handoverId={handoverId} accountId={accountId}
          onClose={() => setPicking(false)} onFiled={afterFile} />
      )}

      {loading && <div style={S.empty}>Loading…</div>}
      {!loading && !threads.length && !picking && (
        <div style={S.empty}>
          No conversations filed yet. Filing one puts the whole thread — and every reply that
          follows — on this project, visible to the project team.
        </div>
      )}

      {threads.map(t => (
        <div key={t.id} style={S.row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.subject || '(no subject)'}
            </div>
            <div style={S.meta}>
              <span>{t.message_count || 0} message{Number(t.message_count) === 1 ? '' : 's'}</span>
              <span>· last {fmtDate(t.last_message_at)}</span>
              {t.tagged_by_name && <span>· filed by {t.tagged_by_name}</span>}
            </div>
          </div>
          {canFile && <button style={S.btn} onClick={() => unfile(t)}>Remove</button>}
        </div>
      ))}
    </div>
  );
}
