/**
 * ProjectFilesPanel.js
 *
 * DROP-IN LOCATION: frontend/src/ProjectFilesPanel.js  (NEW FILE)
 *
 * The Files tab on a project (handover).
 *
 * Browsing is ON DEMAND: mapping a folder does not drag its contents in. You
 * open the browser, look at what is there, and add what belongs. Files already
 * filed are marked so nobody adds the same document twice.
 *
 * Opening a document goes through the project-files open-url endpoint, which
 * checks the READER's own Drive/OneDrive access. When they do not have it we
 * say so plainly — GoWarm does not hold a second set of file permissions, and
 * this panel should not pretend otherwise.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || body?.error || res.statusText);
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

/**
 * Multipart upload.
 *
 * Deliberately not apiFetch: that sets Content-Type: application/json, and for
 * FormData the browser must set the header itself so it can include the
 * multipart boundary. Setting it by hand produces a body the server cannot
 * parse, with a misleading "no file received" at the other end.
 */
async function apiUpload(path, formData) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || res.statusText);
  return body;
}

const PROVIDER_LABELS = { onedrive: 'OneDrive', googledrive: 'Google Drive' };

const CATEGORY_ICONS = {
  transcript: '🎙️', document: '📄', email: '📧', folder: '📁',
  pdf: '📕', spreadsheet: '📊', image: '🖼️',
};

function formatFileSize(bytes) {
  const b = parseInt(bytes, 10);
  if (!b || isNaN(b)) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const S = {
  section:  { marginBottom: 20 },
  h4:       { margin: '0 0 10px', fontSize: 14, color: '#374151' },
  row:      { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              borderBottom: '1px solid #f1f5f9', fontSize: 13 },
  meta:     { fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, flexWrap: 'wrap' },
  btn:      { fontSize: 11, padding: '4px 9px', borderRadius: 4, border: '1px solid #d1d5db',
              background: '#fff', color: '#374151', cursor: 'pointer' },
  btnPri:   { fontSize: 12, padding: '5px 11px', borderRadius: 4, border: 'none',
              background: '#0369a1', color: '#fff', cursor: 'pointer' },
  chip:     { fontSize: 10, padding: '2px 6px', borderRadius: 10, background: '#eff6ff',
              color: '#1d4ed8', border: '1px solid #bfdbfe' },
  chipWarn: { fontSize: 10, padding: '2px 6px', borderRadius: 10, background: '#fef3c7',
              color: '#92400e', border: '1px solid #fde68a' },
  err:      { padding: '7px 10px', background: '#fee2e2', color: '#991b1b',
              borderRadius: 6, fontSize: 12, marginBottom: 10 },
  empty:    { fontSize: 12, color: '#9ca3af', padding: '10px 0' },
};

// ── Folder mappings ──────────────────────────────────────────────────────────

function FolderMappings({ folders, canManage, onUnmap, onSetTarget }) {
  if (!folders.length) {
    return (
      <p style={S.empty}>
        No folders mapped. Mapping a folder means anything you add from it — or from any
        folder inside it — files itself under this project automatically.
      </p>
    );
  }
  return (
    <div>
      {folders.map(f => (
        <div key={f.id} style={S.row}>
          <span>📁</span>
          <div style={{ flex: 1 }}>
            <div>{f.folder_name || f.folder_id}</div>
            <div style={S.meta}>
              <span>{PROVIDER_LABELS[f.provider] || f.provider}</span>
              <span>· includes subfolders</span>
              <span>· {f.file_count || 0} file{Number(f.file_count) === 1 ? '' : 's'} filed this way</span>
              {f.created_by_name && <span>· mapped by {f.created_by_name}</span>}
            </div>
          </div>
          {/* Inbound WhatsApp attachments are written here. Exactly one folder
              per project can be the target, so this is a radio, not a toggle —
              and the file inherits this folder's existing sharing, which is why
              the project team can see it without GoWarm managing permissions. */}
          {canManage && (
            <button
              style={{ ...S.btn, ...(f.is_upload_target
                ? { background: '#0369a1', color: '#fff', border: 'none' } : {}) }}
              title={f.is_upload_target
                ? 'WhatsApp attachments for this project are saved here'
                : 'Save inbound WhatsApp attachments to this folder'}
              onClick={() => onSetTarget(f)}>
              {f.is_upload_target ? '📥 Attachment folder' : 'Use for attachments'}
            </button>
          )}
          {canManage && (
            <button style={S.btn} onClick={() => onUnmap(f)} title="Stop filing this folder under the project">
              Unmap
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── On-demand cloud browser ──────────────────────────────────────────────────

function CloudBrowser({ handoverId, canManage, onClose, onChanged }) {
  const [providers, setProviders] = useState([]);
  const [provider,  setProvider]  = useState(null);
  const [stack,     setStack]     = useState([{ id: null, name: 'My Drive' }]);
  const [items,     setItems]     = useState([]);
  const [status,    setStatus]    = useState({});
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState('');

  const here = stack[stack.length - 1];

  useEffect(() => {
    apiFetch('/storage/providers')
      .then(d => {
        const connected = (d.providers || []).filter(p => p.connected);
        setProviders(connected);
        if (connected.length && !provider) setProvider(connected[0].id);
      })
      .catch(e => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (prov, folderId) => {
    if (!prov) return;
    setBusy(true); setError('');
    try {
      const q = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
      const d = await apiFetch(`/storage/${prov}/files${q}`);
      const files = d.files || [];
      setItems(files);
      const ids = files.filter(f => !f.isFolder).map(f => f.id);
      if (ids.length) {
        const s = await apiFetch(`/project-files/${handoverId}/link-status`, {
          method: 'POST', body: JSON.stringify({ provider: prov, providerFileIds: ids }),
        });
        setStatus(s.status || {});
      } else {
        setStatus({});
      }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }, [handoverId]);

  useEffect(() => { if (provider) load(provider, here.id); }, [provider, here.id, load]);

  async function addFile(file) {
    setBusy(true); setError('');
    try {
      await apiFetch(`/project-files/${handoverId}/files`, {
        method: 'POST', body: JSON.stringify({ provider, providerFileId: file.id }),
      });
      await load(provider, here.id);
      onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function mapThisFolder() {
    setBusy(true); setError('');
    try {
      await apiFetch(`/project-files/${handoverId}/folders`, {
        method: 'POST',
        body: JSON.stringify({ provider, folderId: here.id, folderName: here.name }),
      });
      onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 16, background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>Add files from cloud storage</strong>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {providers.map(p => (
            <button key={p.id} onClick={() => { setProvider(p.id); setStack([{ id: null, name: 'My Drive' }]); }}
              style={{ ...S.btn, background: provider === p.id ? '#0369a1' : '#fff',
                       color: provider === p.id ? '#fff' : '#374151' }}>
              {p.displayName || PROVIDER_LABELS[p.id] || p.id}
            </button>
          ))}
          <button style={S.btn} onClick={onClose}>Close</button>
        </div>
      </div>

      {!providers.length && (
        <p style={S.empty}>No cloud storage connected. Connect Google Drive or OneDrive in Settings first.</p>
      )}
      {error && <div style={S.err}>⚠️ {error}</div>}

      {!!providers.length && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            {stack.map((c, i) => (
              <span key={`${c.id || 'root'}-${i}`}>
                <button
                  onClick={() => i < stack.length - 1 && setStack(stack.slice(0, i + 1))}
                  disabled={i === stack.length - 1}
                  style={{ background: 'none', border: 'none', cursor: i === stack.length - 1 ? 'default' : 'pointer',
                           color: i === stack.length - 1 ? '#111827' : '#0369a1', padding: 0, fontSize: 12 }}>
                  {c.name}
                </button>
                {i < stack.length - 1 && <span style={{ color: '#9ca3af' }}> ›</span>}
              </span>
            ))}
            {canManage && here.id && (
              <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={mapThisFolder} disabled={busy}
                title="Everything added from this folder or its subfolders files under this project">
                📌 Map this folder to the project
              </button>
            )}
          </div>

          {busy && <p style={S.empty}>Loading…</p>}
          {!busy && !items.length && <p style={S.empty}>This folder is empty.</p>}

          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {items.map(f => {
              const linked = status[f.id];
              const here_ = linked && String(linked.handoverId) === String(handoverId);
              return (
                <div key={f.id} style={S.row}>
                  <span>{f.isFolder ? '📁' : (CATEGORY_ICONS[f.category] || '📄')}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {f.isFolder ? (
                      <button onClick={() => setStack([...stack, { id: f.id, name: f.name }])}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                 color: '#0369a1', fontSize: 13, textAlign: 'left' }}>
                        {f.name} ›
                      </button>
                    ) : (
                      <>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                        <div style={S.meta}><span>{formatFileSize(f.size)}</span></div>
                      </>
                    )}
                  </div>
                  {!f.isFolder && here_  && <span style={S.chip}>On this project</span>}
                  {!f.isFolder && linked && !here_ && (
                    <span style={S.chipWarn} title="Adding it here will move it — a file belongs to one project">
                      On {linked.projectName || 'another project'}
                    </span>
                  )}
                  {!f.isFolder && !here_ && (
                    <button style={S.btn} disabled={busy} onClick={() => addFile(f)}>
                      {linked ? 'Move here' : 'Add'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function ProjectFilesPanel({ handoverId }) {
  const [files,     setFiles]     = useState([]);
  const [folders,   setFolders]   = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [canFile,   setCanFile]   = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [browsing,  setBrowsing]  = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [notice,    setNotice]    = useState('');

  const load = useCallback(async () => {
    if (!handoverId) return;
    setLoading(true); setError('');
    try {
      const [f, d] = await Promise.all([
        apiFetch(`/project-files/${handoverId}?includeHidden=${showHidden}`),
        apiFetch(`/project-files/${handoverId}/folders`),
      ]);
      setFiles(f.files || []);
      setCanManage(!!f.canManage);
      setCanFile(!!f.canFile);
      setFolders(d.folders || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [handoverId, showHidden]);

  useEffect(() => { load(); }, [load]);

  async function act(path, method, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setError(''); setNotice('');
    try {
      const out = await apiFetch(path, { method });
      if (out.reclaimedByFolder) {
        setNotice('Removed the direct link. The file is still in a mapped folder, so it stays on the project — hide it to take it off the list.');
      }
      await load();
    } catch (e) { setError(e.message); }
  }

  // One target per project — the backend's partial unique index enforces it, so
  // setting a new one clears the old rather than erroring.
  async function setUploadTarget(folder) {
    setError('');
    try {
      await apiFetch(`/project-files/${handoverId}/folders/${folder.id}/upload-target`, { method: 'POST' });
      await load();
    } catch (e) { setError(`Could not set the attachment folder: ${e.message}`); }
  }

  // The fallback for when automatic WhatsApp capture could not run — someone in
  // the group still has the file on their phone. Goes to the same folder with
  // the same org credential, so a recovered file is indistinguishable from one
  // that arrived automatically.
  async function uploadLocal(e) {
    const chosen = Array.from(e.target.files || []);
    e.target.value = '';                 // allow re-picking the same file
    if (!chosen.length) return;

    setError(''); setNotice(''); setUploading(true);
    const done = [];
    try {
      for (const file of chosen) {
        const fd = new FormData();
        fd.append('file', file);
        const out = await apiUpload(`/project-files/${handoverId}/upload`, fd);
        done.push(out.file?.file_name || file.name);
      }
      setNotice(`Uploaded ${done.length} file${done.length === 1 ? '' : 's'} to the project folder.`);
      await load();
    } catch (err) {
      setError(done.length
        ? `Uploaded ${done.length}, then stopped: ${err.message}`
        : err.message);
      if (done.length) await load();
    } finally { setUploading(false); }
  }

  async function openFile(file) {
    setError('');
    try {
      const { url } = await apiFetch(`/project-files/${handoverId}/files/${file.id}/open-url`, { method: 'POST' });
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      // The provider owns file permissions. Say that, rather than showing a
      // dead link or inventing an access model of our own.
      setError(e.code === 'PROVIDER_ACCESS_DENIED' ? e.message : `Could not open the file: ${e.message}`);
    }
  }

  if (loading) return <p style={S.empty}>Loading files…</p>;

  const visible = files.filter(f => !f.hidden_at);
  const hidden  = files.filter(f => f.hidden_at);

  return (
    <div>
      {error  && <div style={S.err}>⚠️ {error}</div>}
      {notice && <div style={{ ...S.err, background: '#eff6ff', color: '#1e40af' }}>ℹ️ {notice}</div>}

      <div style={S.section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h4 style={{ ...S.h4, margin: 0 }}>
            📎 Project documents
            <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}> · {visible.length} file{visible.length === 1 ? '' : 's'}</span>
          </h4>
          {canFile && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <label style={{ ...S.btn, cursor: uploading ? 'default' : 'pointer', opacity: uploading ? 0.6 : 1 }}
                title="Upload from this computer — the fallback when a WhatsApp attachment was not captured automatically">
                {uploading ? 'Uploading…' : '⬆ Upload from computer'}
                <input type="file" multiple disabled={uploading}
                  onChange={uploadLocal} style={{ display: 'none' }} />
              </label>
              <button style={S.btnPri} onClick={() => setBrowsing(b => !b)}>
                {browsing ? 'Done' : '+ Add files'}
              </button>
            </div>
          )}
        </div>

        {browsing && (
          <CloudBrowser handoverId={handoverId} canManage={canManage}
            onClose={() => setBrowsing(false)} onChanged={load} />
        )}

        {!visible.length && !browsing && (
          <p style={S.empty}>No documents on this project yet. Add them from Google Drive or OneDrive.</p>
        )}

        {visible.map(f => (
          <div key={f.id} style={S.row}>
            <span>{CATEGORY_ICONS[f.category] || '📄'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</div>
              <div style={S.meta}>
                <span>{PROVIDER_LABELS[f.provider] || f.provider}</span>
                <span>· {formatFileSize(f.file_size)}</span>
                {f.tag_source === 'folder'
                  ? <span>· via folder {f.via_folder_name || f.folder_id}</span>
                  : <span>· added by {f.tagged_by_name || 'someone'}</span>}
                {f.deal_id && <span>· also on a deal</span>}
              </div>
            </div>
            <button style={S.btn} onClick={() => openFile(f)}>Open ↗</button>
            {canFile && f.tag_source === 'manual' && (
              <button style={S.btn} title="Remove the direct link"
                onClick={() => act(`/project-files/${handoverId}/files/${f.id}`, 'DELETE')}>Untag</button>
            )}
            {canFile && (
              <button style={S.btn} title="Keep the link, take it off the team's list"
                onClick={() => act(`/project-files/${handoverId}/files/${f.id}/hide`, 'POST')}>Hide</button>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <div style={S.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h4 style={{ ...S.h4, margin: 0 }}>🗂️ Mapped folders</h4>
            <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => setShowHidden(h => !h)}>
              {showHidden ? 'Hide hidden files' : `Show hidden files${hidden.length ? ` (${hidden.length})` : ''}`}
            </button>
          </div>
          <FolderMappings folders={folders} canManage={canManage} onSetTarget={setUploadTarget}
            onUnmap={f => act(`/project-files/${handoverId}/folders/${f.id}`, 'DELETE',
              `Stop filing "${f.folder_name || f.folder_id}" under this project?\n\nFiles added by hand stay. Nothing is deleted from ${PROVIDER_LABELS[f.provider] || f.provider}.`)} />
        </div>
      )}

      {showHidden && canManage && (
        <div style={S.section}>
          <h4 style={S.h4}>🙈 Hidden</h4>
          {!hidden.length && <p style={S.empty}>Nothing hidden.</p>}
          {hidden.map(f => (
            <div key={f.id} style={{ ...S.row, opacity: 0.7 }}>
              <span>{CATEGORY_ICONS[f.category] || '📄'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{f.file_name}</div>
                <div style={S.meta}><span>hidden by {f.hidden_by_name || 'someone'}</span></div>
              </div>
              <button style={S.btn}
                onClick={() => act(`/project-files/${handoverId}/files/${f.id}/unhide`, 'POST')}>Unhide</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
