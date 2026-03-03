/**
 * FilesView.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: frontend/src/FilesView.js
 *
 * Key changes from original:
 *   - All hardcoded "OneDrive" strings replaced with dynamic provider labels
 *   - Connection banner shows all connected providers (OneDrive, Google Drive, or both)
 *   - Import button text and empty state are provider-aware
 *   - File links say "Open in cloud storage" or use provider-specific labels
 *   - Delete confirmation no longer says "OneDrive" — uses generic cloud wording
 */

import React, { useState, useEffect, useCallback } from 'react';
import CloudFilePicker from './CloudFilePicker';
import './FilesView.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

// ── Auth helper — matches App.js which saves under 'token' ────────────────
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(`${API_BASE}${path.replace('/api/', '/')}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function formatFileSize(bytes) {
  const b = parseInt(bytes, 10);
  if (!b || isNaN(b)) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const CATEGORY_ICONS = {
  transcript: '🎙️',
  document:   '📄',
  email:      '📧',
  folder:     '📁',
  pdf:        '📕',
  spreadsheet:'📊',
  image:      '🖼️',
};

const CATEGORY_COLORS = {
  transcript:  '#8b5cf6',
  document:    '#3b82f6',
  email:       '#f59e0b',
  pdf:         '#ef4444',
  spreadsheet: '#10b981',
  image:       '#ec4899',
};

const PROVIDER_LABELS = {
  onedrive:    'OneDrive',
  googledrive: 'Google Drive',
};

const PROVIDER_OPEN_LABELS = {
  onedrive:    'Open in OneDrive',
  googledrive: 'Open in Google Drive',
};

export default function FilesView() {
  const [importedFiles, setImportedFiles]   = useState([]);
  const [deals, setDeals]                   = useState([]);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);
  const [connectionStatus, setConnectionStatus] = useState(null);
  const [showPicker, setShowPicker]         = useState(false);
  const [filterDeal, setFilterDeal]         = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [searchQuery, setSearchQuery]       = useState('');
  const [sortBy, setSortBy]                 = useState('date_desc');
  const [deletingId, setDeletingId]         = useState(null);
  const [successMsg, setSuccessMsg]         = useState('');

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, dealsRes, filesRes] = await Promise.allSettled([
        apiFetch('/storage/providers'),
        apiFetch('/deals'),
        apiFetch('/storage/imported/all'),
      ]);

      if (statusRes.status === 'fulfilled') {
        const allProviders = statusRes.value.providers || [];
        const connectedProviders = allProviders.filter(p => p.connected);
        setConnectionStatus({
          providers: allProviders,
          anyConnected: connectedProviders.length > 0,
          connectedProviders,
          connectedNames: connectedProviders.map(p => PROVIDER_LABELS[p.id] || p.displayName || p.id).join(' & '),
        });
      }

      if (dealsRes.status === 'fulfilled') {
        setDeals(dealsRes.value.deals || dealsRes.value || []);
      }

      if (filesRes.status === 'fulfilled') {
        setImportedFiles(filesRes.value.files || []);
      } else {
        setImportedFiles([]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const handlePickerComplete = useCallback((results) => {
    setShowPicker(false);
    const count = results?.processed || 0;
    setSuccessMsg(`✅ ${count} file${count !== 1 ? 's' : ''} imported successfully`);
    setTimeout(() => setSuccessMsg(''), 4000);
    loadAll();
  }, []);

  const handleDelete = async (recordId, fileName) => {
    if (!window.confirm(`Remove the import record for "${fileName}"?\n\nThe original file in your cloud storage will not be deleted.`)) return;
    setDeletingId(recordId);
    try {
      await apiFetch(`/storage/imported/${recordId}`, { method: 'DELETE' });
      setImportedFiles(prev => prev.filter(f => f.id !== recordId));
      setSuccessMsg(`🗑️ "${fileName}" import record removed`);
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (e) {
      setError('Failed to delete: ' + e.message);
    } finally {
      setDeletingId(null);
    }
  };

  // ── Derived: filtered + sorted files ──────────────────────────────────────
  const filteredFiles = importedFiles
    .filter(f => {
      if (filterDeal !== 'all' && String(f.deal_id) !== String(filterDeal)) return false;
      if (filterCategory !== 'all' && f.category !== filterCategory) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (!f.file_name?.toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'date_desc') return new Date(b.imported_at || b.created_at) - new Date(a.imported_at || a.created_at);
      if (sortBy === 'date_asc')  return new Date(a.imported_at || a.created_at) - new Date(b.imported_at || b.created_at);
      if (sortBy === 'name')      return (a.file_name || '').localeCompare(b.file_name || '');
      if (sortBy === 'size_desc') return (parseInt(b.file_size, 10) || 0) - (parseInt(a.file_size, 10) || 0);
      return 0;
    });

  const categories = [...new Set(importedFiles.map(f => f.category).filter(Boolean))];

  // ── Stats ──────────────────────────────────────────────────────────────────
  const totalSize = importedFiles.reduce((sum, f) => sum + (parseInt(f.file_size, 10) || 0), 0);
  const dealCount = new Set(importedFiles.map(f => f.deal_id).filter(Boolean)).size;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="files-view">
        <div className="files-loading">
          <div className="files-spinner" />
          <p>Loading files…</p>
        </div>
      </div>
    );
  }

  // Build dynamic label for connected providers
  const connectedNames = connectionStatus?.connectedNames || 'cloud storage';
  const importButtonLabel = connectionStatus?.anyConnected
    ? `+ Import from ${connectedNames}`
    : '+ Import from Cloud Storage';

  return (
    <div className="files-view">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="files-header">
        <div className="files-header-left">
          <h2>☁️ Cloud Files</h2>
          <p className="files-subtitle">Files imported from cloud storage and linked to your deals</p>
        </div>
        <div className="files-header-right">
          <button
            className="files-btn files-btn--primary"
            onClick={() => setShowPicker(true)}
            disabled={!connectionStatus?.anyConnected}
            title={!connectionStatus?.anyConnected ? 'Connect a cloud storage provider in Settings first' : ''}
          >
            {importButtonLabel}
          </button>
        </div>
      </div>

      {/* ── Connection Banner ─────────────────────────────────────────────── */}
      {connectionStatus && !connectionStatus.anyConnected && (
        <div className="files-banner files-banner--warn">
          <span>⚠️ No cloud storage connected.</span>
          <span>Connect your Google or Microsoft account via <strong>Settings → Integrations</strong> to import files.</span>
        </div>
      )}

      {connectionStatus?.anyConnected && (
        <div className="files-banner files-banner--ok">
          <span>✅ Connected: {connectedNames}</span>
        </div>
      )}

      {/* ── Messages ──────────────────────────────────────────────────────── */}
      {successMsg && <div className="files-banner files-banner--success">{successMsg}</div>}
      {error      && <div className="files-banner files-banner--error">❌ {error}</div>}

      {/* ── Stats bar ─────────────────────────────────────────────────────── */}
      <div className="files-stats">
        <div className="files-stat">
          <span className="files-stat-val">{importedFiles.length}</span>
          <span className="files-stat-label">Total Files</span>
        </div>
        <div className="files-stat">
          <span className="files-stat-val">{dealCount}</span>
          <span className="files-stat-label">Deals with Files</span>
        </div>
        <div className="files-stat">
          <span className="files-stat-val">{formatFileSize(totalSize)}</span>
          <span className="files-stat-label">Total Size</span>
        </div>
        <div className="files-stat">
          <span className="files-stat-val">{categories.length}</span>
          <span className="files-stat-label">File Types</span>
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      <div className="files-controls">
        <input
          className="files-search"
          type="text"
          placeholder="Search files…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />

        <select className="files-select" value={filterDeal} onChange={e => setFilterDeal(e.target.value)}>
          <option value="all">All Deals</option>
          {deals.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <select className="files-select" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
          <option value="all">All Types</option>
          {categories.map(c => (
            <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
          ))}
        </select>

        <select className="files-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="date_desc">Newest First</option>
          <option value="date_asc">Oldest First</option>
          <option value="name">Name A–Z</option>
          <option value="size_desc">Largest First</option>
        </select>
      </div>

      {/* ── File Table ────────────────────────────────────────────────────── */}
      {filteredFiles.length === 0 ? (
        <EmptyState
          hasFiles={importedFiles.length > 0}
          isFiltered={filteredFiles.length !== importedFiles.length}
          connected={connectionStatus?.anyConnected}
          connectedNames={connectedNames}
          onImport={() => setShowPicker(true)}
          onClearFilters={() => { setFilterDeal('all'); setFilterCategory('all'); setSearchQuery(''); }}
        />
      ) : (
        <div className="files-table-wrap">
          <table className="files-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Deal</th>
                <th>Size</th>
                <th>Imported</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.map(file => {
                const deal = deals.find(d => String(d.id) === String(file.deal_id));
                const catColor = CATEGORY_COLORS[file.category] || '#6b7280';
                const catIcon  = CATEGORY_ICONS[file.category]  || '📄';
                const openLabel = PROVIDER_OPEN_LABELS[file.provider] || 'Open in cloud storage';
                return (
                  <tr key={file.id} className="files-row">
                    <td className="files-cell files-cell--name">
                      <span className="files-file-icon">{catIcon}</span>
                      <div className="files-name-wrap">
                        <span className="files-name">{file.file_name || 'Unnamed file'}</span>
                        {file.web_url && (
                          <a
                            href={file.web_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="files-open-link"
                            onClick={e => e.stopPropagation()}
                          >
                            {openLabel} ↗
                          </a>
                        )}
                      </div>
                    </td>

                    <td className="files-cell">
                      <span className="files-category-badge" style={{ background: catColor + '18', color: catColor, border: `1px solid ${catColor}40` }}>
                        {file.category || 'file'}
                      </span>
                    </td>

                    <td className="files-cell files-cell--deal">
                      {deal ? (
                        <span className="files-deal-tag">
                          💼 {deal.name}
                        </span>
                      ) : (
                        <span className="files-no-deal">—</span>
                      )}
                    </td>

                    <td className="files-cell files-cell--meta">
                      {formatFileSize(file.file_size)}
                    </td>

                    <td className="files-cell files-cell--meta">
                      {formatDate(file.imported_at || file.created_at)}
                    </td>

                    <td className="files-cell">
                      <span className="files-source-badge">
                        ☁️ {file.source_label || PROVIDER_LABELS[file.provider] || file.provider || 'Cloud'}
                      </span>
                    </td>

                    <td className="files-cell files-cell--actions">
                      {file.web_url && (
                        <a
                          href={file.web_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="files-icon-btn"
                          title={openLabel}
                        >
                          ↗
                        </a>
                      )}
                      <button
                        className="files-icon-btn files-icon-btn--danger"
                        title="Remove import record"
                        disabled={deletingId === file.id}
                        onClick={() => handleDelete(file.id, file.file_name)}
                      >
                        {deletingId === file.id ? '…' : '🗑️'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="files-count">{filteredFiles.length} file{filteredFiles.length !== 1 ? 's' : ''}</div>
        </div>
      )}

      {/* ── Cloud File Picker Modal ────────────────────────────────────────── */}
      {showPicker && (
        <CloudFilePicker
          onComplete={handlePickerComplete}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

function EmptyState({ hasFiles, isFiltered, connected, connectedNames, onImport, onClearFilters }) {
  if (isFiltered) {
    return (
      <div className="files-empty">
        <div className="files-empty-icon">🔍</div>
        <h3>No files match your filters</h3>
        <p>Try adjusting your search or filter criteria</p>
        <button className="files-btn files-btn--secondary" onClick={onClearFilters}>
          Clear Filters
        </button>
      </div>
    );
  }
  return (
    <div className="files-empty">
      <div className="files-empty-icon">☁️</div>
      <h3>No files imported yet</h3>
      {connected ? (
        <>
          <p>Import files from {connectedNames} to link them to your deals and run AI analysis</p>
          <button className="files-btn files-btn--primary" onClick={onImport}>
            + Import from {connectedNames}
          </button>
        </>
      ) : (
        <>
          <p>Connect your Google or Microsoft account in <strong>Settings → Integrations</strong> to get started</p>
        </>
      )}
    </div>
  );
}
