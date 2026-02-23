import React, { useState, useEffect, useCallback } from 'react';
import './DealFilesPanel.css';

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
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || e?.error || r.statusText)));
    return r.json();
  });
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const CATEGORY_ICONS = {
  transcript:  '🎙️',
  document:    '📄',
  email:       '📧',
  folder:      '📁',
  pdf:         '📕',
  spreadsheet: '📊',
  image:       '🖼️',
};

const CATEGORY_COLORS = {
  transcript:  '#8b5cf6',
  document:    '#3b82f6',
  email:       '#f59e0b',
  pdf:         '#ef4444',
  spreadsheet: '#10b981',
  image:       '#ec4899',
};

export default function DealFilesPanel({ deal }) {
  const [files,      setFiles]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [deletingId, setDeletingId] = useState(null);

  const fetchFiles = useCallback(async () => {
    if (!deal?.id) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/storage/imported/deal/${deal.id}`);
      setFiles(data.files || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  async function handleDelete(fileId, fileName) {
    if (!window.confirm(`Remove "${fileName}" from this deal?\n\nThe file in your cloud storage will not be deleted.`)) return;
    setDeletingId(fileId);
    try {
      await apiFetch(`/storage/imported/${fileId}`, { method: 'DELETE' });
      setFiles(prev => prev.filter(f => f.id !== fileId));
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="dfp-loading">
        <span className="dfp-spinner" /> Loading files…
      </div>
    );
  }

  return (
    <div className="dfp-root">

      {/* Header */}
      <div className="dfp-header">
        <span className="dfp-count">
          {files.length === 0
            ? 'No files linked yet'
            : `${files.length} file${files.length !== 1 ? 's' : ''}`}
        </span>
        <button
          className="dfp-btn dfp-btn--manage"
          onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'files' } }))}
          title="Manage all files"
        >
          Manage Files ↗
        </button>
      </div>

      {error && <div className="dfp-error">⚠️ {error}</div>}

      {/* Empty state */}
      {files.length === 0 && !error && (
        <p className="dfp-empty">
          No files have been linked to this deal yet. Import files from your cloud storage in the{' '}
          <span
            className="dfp-link"
            onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'files' } }))}
          >
            Files
          </span>{' '}
          tab.
        </p>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="dfp-list">
          {files.map(file => {
            const icon     = CATEGORY_ICONS[file.category]  || '📄';
            const catColor = CATEGORY_COLORS[file.category] || '#6b7280';

            return (
              <div key={file.id} className="dfp-file">
                {/* Icon */}
                <span className="dfp-file-icon">{icon}</span>

                {/* Info */}
                <div className="dfp-file-info">
                  <div className="dfp-file-name">{file.file_name || 'Unnamed file'}</div>
                  <div className="dfp-file-meta">
                    <span
                      className="dfp-category-badge"
                      style={{ background: catColor + '18', color: catColor, border: `1px solid ${catColor}40` }}
                    >
                      {file.category || 'file'}
                    </span>
                    <span>{formatFileSize(file.file_size)}</span>
                    <span>{formatDate(file.imported_at || file.created_at)}</span>
                    {(file.source_label || file.provider) && (
                      <span>☁️ {file.source_label || file.provider}</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="dfp-file-actions">
                  {file.web_url && (
                    <a
                      href={file.web_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dfp-icon-btn"
                      title="Open in cloud storage"
                    >
                      ↗
                    </a>
                  )}
                  <button
                    className="dfp-icon-btn dfp-icon-btn--danger"
                    title="Remove from deal"
                    disabled={deletingId === file.id}
                    onClick={() => handleDelete(file.id, file.file_name)}
                  >
                    {deletingId === file.id ? '…' : '🗑️'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
