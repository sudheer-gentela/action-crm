// ─────────────────────────────────────────────────────────────────────────────
// ProjectPlayModals.js — write paths for plan vs actual (2026_111)
//
//   PlayDateModal      change a play's due date, always with attribution;
//                      optionally re-baseline if the user is permitted
//   PlayEvidenceModal  attach a WhatsApp message as proof of completion, and
//                      withdraw one that was attached in error
//
// Both are deliberately modal rather than inline. Moving a planned date and
// accepting proof of completion are the two acts a variance report is built on
// — an inline field invites them to happen by accident, and an accidental
// re-baseline silently erases a slip.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const C = {
  line: '#e5e7eb', muted: '#6b7280', danger: '#b91c1c',
  warn: '#b45309', warnBg: '#fef3c7', ok: '#047857', accent: '#0369a1',
};

function toInputDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? '—'
    : dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}

function Shell({ title, onClose, children, width = 480 }) {
  return (
    <>
      <div onClick={onClose}
           style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2000 }} />
      <div role="dialog" aria-label={title}
           style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                    width: `min(${width}px, 94vw)`, maxHeight: '86vh', overflowY: 'auto',
                    background: '#fff', borderRadius: 10, zIndex: 2001,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.line}`,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <button onClick={onClose} aria-label="Close"
                  style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: C.muted }}>×</button>
        </div>
        <div style={{ padding: '16px 18px' }}>{children}</div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PlayDateModal
// ─────────────────────────────────────────────────────────────────────────────
export function PlayDateModal({ handoverId, play, onClose, onSaved }) {
  const [date,    setDate]    = useState(toInputDate(play.dueDate));
  const [reason,  setReason]  = useState('');
  const [rebase,  setRebase]  = useState(false);
  const [allowed, setAllowed] = useState(null);   // null = still checking
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);

  // Ask the server rather than inferring from a role in the client. The service
  // enforces this regardless; hiding the control just avoids offering something
  // that would be rejected.
  useEffect(() => {
    let dead = false;
    apiService.handovers.canRebaseline(handoverId)
      .then(r => { if (!dead) setAllowed(Boolean(r.data && r.data.canRebaseline)); })
      .catch(() => { if (!dead) setAllowed(false); });
    return () => { dead = true; };
  }, [handoverId]);

  const changed = toInputDate(play.dueDate) !== date;
  // A re-baseline without a stated reason is indistinguishable from quietly
  // covering a slip, so the server requires one. Mirrored here to fail fast.
  const needsReason = rebase && !reason.trim();
  const canSave = changed && !needsReason && !saving;

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await apiService.handovers.updatePlay(handoverId, play.id, {
        dueDate:    date || null,
        reason:     reason.trim() || undefined,
        rebaseline: rebase || undefined,
      });
      onSaved && onSaved();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not save the new date');
      setSaving(false);
    }
  };

  return (
    <Shell title="Change planned date" onClose={onClose}>
      <div style={{ fontSize: 13, marginBottom: 12 }}>{play.title}</div>

      <div style={{ display: 'flex', gap: 18, fontSize: 12, color: C.muted, marginBottom: 14 }}>
        <div>Baseline<div style={{ color: '#111827', fontSize: 13 }}>{fmtDate(play.baselineDueDate)}</div></div>
        <div>Current due<div style={{ color: '#111827', fontSize: 13 }}>{fmtDate(play.dueDate)}</div></div>
      </div>

      <label style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>New date</label>
      <input type="date" value={date} onChange={e => setDate(e.target.value)}
             style={{ width: '100%', padding: '7px 9px', border: `1px solid ${C.line}`,
                      borderRadius: 6, fontSize: 13, marginBottom: 12 }} />

      <label style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>
        Reason {rebase ? <span style={{ color: C.danger }}>(required to re-baseline)</span> : '(optional)'}
      </label>
      <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                placeholder="Why is the date moving?"
                style={{ width: '100%', padding: '7px 9px', border: `1px solid ${C.line}`,
                         borderRadius: 6, fontSize: 13, resize: 'vertical', marginBottom: 12 }} />

      {allowed && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12,
                        background: rebase ? C.warnBg : '#f9fafb', padding: '9px 11px',
                        borderRadius: 6, marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={rebase} onChange={e => setRebase(e.target.checked)}
                 style={{ marginTop: 2 }} />
          <span>
            <strong>Re-baseline</strong> — treat this as an approved replan, not a slip.
            <div style={{ color: rebase ? C.warn : C.muted, marginTop: 3, lineHeight: 1.5 }}>
              The baseline moves to the new date and variance resets. The original
              ({fmtDate(play.baselineDueDate)}) is kept in the date history, and the play is
              badged as re-baselined so the reset stays visible.
            </div>
          </span>
        </label>
      )}

      {allowed === false && (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
          This will be recorded as a slip. Only the project owner, an admin, or a member granted
          re-baseline rights can reset the baseline.
        </div>
      )}

      {error && (
        <div style={{ background: '#fee2e2', color: C.danger, padding: '7px 10px',
                      borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '7px 14px', fontSize: 13, borderRadius: 6,
                border: `1px solid ${C.line}`, background: '#fff', cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={!canSave}
                title={!changed ? 'Pick a different date first' : (needsReason ? 'A re-baseline needs a reason' : '')}
                style={{ padding: '7px 14px', fontSize: 13, borderRadius: 6, border: 'none',
                         background: canSave ? C.accent : '#cbd5e1', color: '#fff',
                         cursor: canSave ? 'pointer' : 'not-allowed' }}>
          {saving ? 'Saving…' : (rebase ? 'Re-baseline' : 'Save date')}
        </button>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceFile — one attached file, thumbnailed when it is an image (2026_124)
//
// The file itself lives in the org's Drive/OneDrive. snapshot_web_url is what
// the provider returned at acceptance, so it is what we link to; fileLive says
// whether the storage_files row still exists behind it.
//
// A dead link is shown, not hidden. "This was accepted and the file has since
// gone" is the thing an auditor needs to see — silently dropping the row would
// make the trail read as though nothing was ever attached.
// ─────────────────────────────────────────────────────────────────────────────
function prettySize(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function EvidenceFile({ e }) {
  const size = prettySize(e.fileSize);
  const body = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span>{e.isImage ? '🖼' : '📎'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {e.fileName || 'file'}
      </span>
      {size && <span style={{ color: C.muted, fontSize: 11 }}>{size}</span>}
    </span>
  );
  return (
    <div>
      {e.isImage && e.webUrl && e.fileLive && (
        <a href={e.webUrl} target="_blank" rel="noopener noreferrer">
          <img src={e.webUrl} alt={e.fileName || 'evidence'}
               style={{ maxWidth: 190, maxHeight: 130, borderRadius: 6,
                        border: `1px solid ${C.line}`, display: 'block', marginBottom: 5,
                        objectFit: 'cover' }}
               // Drive thumbnails need a session the browser may not have.
               // Falling back to the filename link is better than a broken icon.
               onError={ev => { ev.currentTarget.style.display = 'none'; }} />
        </a>
      )}
      {e.webUrl && e.fileLive
        ? <a href={e.webUrl} target="_blank" rel="noopener noreferrer"
             style={{ fontSize: 12, color: '#0369a1', textDecoration: 'none' }}>{body}</a>
        : <span style={{ fontSize: 12, color: C.muted }}>
            {body}
            <span style={{ marginLeft: 8, color: C.warn }}>· file no longer available</span>
          </span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PlayEvidenceModal
// ─────────────────────────────────────────────────────────────────────────────
export function PlayEvidenceModal({ handoverId, play, onClose, onSaved }) {
  const [existing, setExisting] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [picked,   setPicked]   = useState(null);
  const [note,     setNote]     = useState('');
  const [filter,   setFilter]   = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState(null);
  const [warn,     setWarn]     = useState(null);
  // 2026_124: evidence has two sources now. Tabs rather than one merged list,
  // because "pick a message we already have" and "upload what's on my phone"
  // are different acts with different affordances.
  const [tab,      setTab]      = useState('message');   // 'message' | 'upload'
  const [file,     setFile]     = useState(null);
  const fileInput = React.useRef(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ev, comms] = await Promise.all([
        apiService.handovers.playEvidence(handoverId, play.id),
        apiService.handovers.communications(handoverId),
      ]);
      setExisting(ev.data?.evidence || []);
      // The communications feed is the only place project-attributed WhatsApp
      // messages are already assembled, so it is reused rather than adding a
      // second endpoint that could drift from it. Ids arrive as 'wa-<id>'.
      const items = (comms.data?.items || []).filter(i => i.channel === 'whatsapp');
      setMessages(items);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not load messages');
    } finally {
      setLoading(false);
    }
  }, [handoverId, play.id]);

  useEffect(() => { load(); }, [load]);

  const waId = (id) => {
    const m = /^wa-(\d+)$/.exec(String(id || ''));
    return m ? parseInt(m[1], 10) : null;
  };

  const attach = async () => {
    const messageId = waId(picked);
    if (!messageId) return;
    setBusy(true); setError(null); setWarn(null);
    try {
      const r = await apiService.handovers.addPlayEvidence(handoverId, play.id, {
        whatsappMessageId: messageId,
        note: note.trim() || undefined,
      });
      const w = r.data?.warnings;
      if (Array.isArray(w) && w.length) setWarn(w.join(' '));
      setPicked(null); setNote('');
      await load();
      onSaved && onSaved();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not attach that message');
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async () => {
    if (!file) return;
    setBusy(true); setError(null); setWarn(null);
    try {
      const r = await apiService.handovers.uploadPlayEvidence(
        handoverId, play.id, file, note.trim() || undefined);
      const w = r.data?.warnings;
      if (Array.isArray(w) && w.length) setWarn(w.join(' '));
      setFile(null); setNote('');
      if (fileInput.current) fileInput.current.value = '';
      await load();
      onSaved && onSaved();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not upload that file');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (evidenceId) => {
    // Required by the server too — evidence is append-only and a withdrawal is
    // itself recorded, so it must say why.
    const reason = window.prompt('Why is this evidence being withdrawn?');
    if (reason === null) return;
    if (!reason.trim()) { setError('A reason is required to withdraw evidence.'); return; }
    setBusy(true); setError(null);
    try {
      await apiService.handovers.revokePlayEvidence(handoverId, evidenceId, reason.trim());
      await load();
      onSaved && onSaved();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not withdraw that evidence');
    } finally {
      setBusy(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? messages.filter(m => `${m.body || ''} ${m.from || ''}`.toLowerCase().includes(q))
    : messages;

  return (
    <Shell title="Evidence of completion" onClose={onClose} width={560}>
      <div style={{ fontSize: 13, marginBottom: 12 }}>{play.title}</div>

      {error && (
        <div style={{ background: '#fee2e2', color: C.danger, padding: '7px 10px',
                      borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{error}</div>
      )}
      {warn && (
        <div style={{ background: C.warnBg, color: C.warn, padding: '7px 10px',
                      borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{warn}</div>
      )}

      {existing.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>Attached</div>
          {existing.map(e => (
            <div key={e.id} style={{ border: `1px solid ${C.line}`, borderRadius: 6,
                                     padding: '8px 10px', marginBottom: 6, opacity: e.revoked ? 0.55 : 1 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>
                {e.channel === 'file'
                  ? <>Uploaded by {e.acceptedBy || 'unknown'} · {fmtDate(e.acceptedAt)}</>
                  : <>{e.sender || 'unknown'} · {fmtDate(e.sentAt)}</>}
                {e.revoked && <span style={{ color: C.danger, marginLeft: 8 }}>withdrawn</span>}
                {e.messageMoved && !e.revoked && (
                  <span style={{ color: C.warn, marginLeft: 8 }}>message re-filed elsewhere</span>
                )}
              </div>
              {e.channel === 'file' ? (
                <div style={{ fontSize: 12 }}>
                  <EvidenceFile e={e} />
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{e.body || '(no text)'}</div>
                  {/* A photo sent over WhatsApp: the picture is the proof, and
                      before 2026_124 only its caption was recorded. */}
                  {e.fileName && <div style={{ marginTop: 6 }}><EvidenceFile e={e} /></div>}
                </>
              )}
              {!e.revoked && (
                <button onClick={() => revoke(e.id)} disabled={busy}
                        style={{ marginTop: 6, fontSize: 11, padding: '3px 8px', borderRadius: 5,
                                 border: `1px solid ${C.line}`, background: '#fff',
                                 color: C.danger, cursor: 'pointer' }}>Withdraw</button>
              )}
              {e.revoked && e.revokeReason && (
                <div style={{ fontSize: 11, color: C.danger, marginTop: 4 }}>{e.revokeReason}</div>
              )}
            </div>
          ))}
          <div style={{ height: 1, background: C.line, margin: '14px 0' }} />
        </>
      )}

      {/* Two sources (2026_124). Message evidence proves it was communicated;
          an upload proves it was done. Both are first-class. */}
      <div style={{ display: 'inline-flex', border: `1px solid ${C.line}`, borderRadius: 6,
                    overflow: 'hidden', marginBottom: 10 }}>
        {[['message', 'Pick a WhatsApp message'], ['upload', 'Upload a file']].map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setError(null); setWarn(null); }}
            style={{ fontSize: 12, padding: '5px 12px', border: 'none', cursor: 'pointer',
                     fontWeight: tab === k ? 600 : 400,
                     background: tab === k ? C.accent : '#fff',
                     color: tab === k ? '#fff' : '#374151' }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'upload' && (
        <div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, lineHeight: 1.5 }}>
            The file is uploaded to this project's folder in your organisation's Drive or
            OneDrive — never stored in the database. If the project has no attachment folder
            mapped yet, an admin needs to set one on the Files tab first.
          </div>
          <input ref={fileInput} type="file"
                 onChange={ev => setFile(ev.target.files?.[0] || null)}
                 style={{ fontSize: 12, marginBottom: 8, display: 'block' }} />
          {file && (
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
              {file.name} · {prettySize(file.size)}
            </div>
          )}
          <input value={note} onChange={ev => setNote(ev.target.value)}
                 placeholder="Note (optional) — what does this prove?"
                 style={{ width: '100%', padding: '6px 9px', border: `1px solid ${C.line}`,
                          borderRadius: 6, fontSize: 12, marginBottom: 10 }} />
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            The file's name and location are copied into the record when you attach it, so the
            trail survives even if the file is later moved or removed. Attached evidence cannot
            be edited — only withdrawn, with a reason.
          </div>
          <button onClick={uploadFile} disabled={!file || busy}
            style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none',
                     fontWeight: 600,
                     background: (!file || busy) ? '#e5e7eb' : C.accent,
                     color: (!file || busy) ? C.muted : '#fff',
                     cursor: (!file || busy) ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Uploading…' : 'Upload as evidence'}
          </button>
        </div>
      )}

      {tab === 'message' && (
      <>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Attach a WhatsApp message from this project
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: C.muted }}>Loading messages…</div>
      ) : messages.length === 0 ? (
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
          No WhatsApp messages are filed against this project yet. Bind a group to the project in
          Communications first, and its messages become available here.
        </div>
      ) : (
        <>
          <input value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="Search messages…"
                 style={{ width: '100%', padding: '6px 9px', border: `1px solid ${C.line}`,
                          borderRadius: 6, fontSize: 12, marginBottom: 8 }} />
          <div style={{ maxHeight: 210, overflowY: 'auto', border: `1px solid ${C.line}`, borderRadius: 6 }}>
            {shown.length === 0 && (
              <div style={{ padding: 10, fontSize: 12, color: C.muted }}>Nothing matches that search.</div>
            )}
            {shown.map(m => {
              const sel = picked === m.id;
              return (
                <div key={m.id} onClick={() => setPicked(sel ? null : m.id)}
                     style={{ padding: '8px 10px', borderBottom: `1px solid ${C.line}`,
                              cursor: 'pointer', background: sel ? '#eff6ff' : '#fff' }}>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {m.from || 'unknown'} · {fmtDate(m.at)}
                  </div>
                  <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {(m.body || '(no text)').slice(0, 220)}
                  </div>
                </div>
              );
            })}
          </div>

          <input value={note} onChange={e => setNote(e.target.value)}
                 placeholder="Note (optional) — what does this prove?"
                 style={{ width: '100%', padding: '6px 9px', border: `1px solid ${C.line}`,
                          borderRadius: 6, fontSize: 12, margin: '10px 0' }} />

          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            The message text is copied into the record when you attach it, so the proof survives
            even if the message is later re-filed to another project. Attached evidence cannot be
            edited — only withdrawn, with a reason.
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ padding: '7px 14px', fontSize: 13, borderRadius: 6,
                    border: `1px solid ${C.line}`, background: '#fff', cursor: 'pointer' }}>Close</button>
            <button onClick={attach} disabled={!picked || busy}
                    style={{ padding: '7px 14px', fontSize: 13, borderRadius: 6, border: 'none',
                             background: picked && !busy ? C.ok : '#cbd5e1', color: '#fff',
                             cursor: picked && !busy ? 'pointer' : 'not-allowed' }}>
              {busy ? 'Attaching…' : 'Attach as evidence'}
            </button>
          </div>
        </>
      )}
      </>
      )}
    </Shell>
  );
}
