// CloudFilePicker.js
//
// Provider-agnostic file picker. Replaces OneDriveFilePicker.js.
// Shows a tab/switcher for each connected provider.
// File browsing, search, selection, and pipeline config work identically
// regardless of which provider is active.
//
// Props:
//   dealId      {string}
//   contactId   {string}
//   onComplete  {function(results)}
//   onClose     {function}

import React, { useState, useEffect, useCallback } from 'react';
import './CloudFilePicker.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

const PROVIDER_ICONS = {
  onedrive:    '☁️',
  googledrive: '🟢',
};

const FILE_ICONS = {
  transcript: '🎙️',
  document:   '📄',
  email:      '📧',
  folder:     '📁',
};

const PIPELINE_LABELS = {
  aiAnalysis:         'AI Analysis',
  rulesEngine:        'Rules Engine',
  transcriptAnalyzer: 'Transcript Analyzer',
  dealHealth:         'Deal Health Score',
};

export default function CloudFilePicker({ dealId, contactId, onComplete, onClose }) {
  const [providers, setProviders]             = useState([]);
  const [activeProvider, setActiveProvider]   = useState(null);
  const [providerStatuses, setProviderStatuses] = useState({});
  const [loadingProviders, setLoadingProviders] = useState(true);

  const [files, setFiles]                     = useState([]);
  const [folderStack, setFolderStack]         = useState([{ id: null, name: 'My Drive' }]);
  const [searchQuery, setSearchQuery]         = useState('');
  const [isSearching, setIsSearching]         = useState(false);
  const [selectedFiles, setSelectedFiles]     = useState(new Set());
  const [pipelines, setPipelines]             = useState({
    aiAnalysis: true,
    rulesEngine: true,
    transcriptAnalyzer: true,
    dealHealth: !!dealId,
  });
  const [loadingFiles, setLoadingFiles]       = useState(false);
  const [processing, setProcessing]           = useState(false);
  const [processingResults, setProcessingResults] = useState(null);
  const [error, setError]                     = useState(null);

  const currentFolder = folderStack[folderStack.length - 1];

  // ── Load all providers + their connection status on mount ─────────────────
  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    try {
      const res = await apiFetch('/api/storage/providers');
      setProviders(res.providers);
      const statuses = {};
      res.providers.forEach((p) => { statuses[p.id] = p; });
      setProviderStatuses(statuses);
      // Auto-select first connected provider
      const first = res.providers.find((p) => p.connected);
      if (first) {
        setActiveProvider(first.id);
        loadFiles(first.id, null);
      } else if (res.providers.length > 0) {
        setActiveProvider(res.providers[0].id);
      }
    } catch (e) {
      setError('Failed to load storage providers: ' + e.message);
    } finally {
      setLoadingProviders(false);
    }
  }

  // ── Switch provider tab ────────────────────────────────────────────────────
  function switchProvider(providerId) {
    if (providerId === activeProvider) return;
    setActiveProvider(providerId);
    setFiles([]);
    setFolderStack([{ id: null, name: 'My Drive' }]);
    setSelectedFiles(new Set());
    setSearchQuery('');
    setIsSearching(false);
    setError(null);
    const status = providerStatuses[providerId];
    if (status?.connected) {
      loadFiles(providerId, null);
    }
  }

  // ── Load files ─────────────────────────────────────────────────────────────
  const loadFiles = useCallback(async (providerId, folderId) => {
    setLoadingFiles(true);
    setError(null);
    try {
      const params = folderId ? `?folderId=${folderId}` : '';
      const res = await apiFetch(`/api/storage/${providerId}/files${params}`);
      setFiles(res.files || []);
    } catch (e) {
      setError('Failed to load files: ' + e.message);
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  // ── Search ─────────────────────────────────────────────────────────────────
  async function handleSearch(e) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setLoadingFiles(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/storage/${activeProvider}/files/search?q=${encodeURIComponent(searchQuery)}`
      );
      setFiles(res.files || []);
    } catch (e) {
      setError('Search failed: ' + e.message);
    } finally {
      setLoadingFiles(false);
    }
  }

  function clearSearch() {
    setSearchQuery('');
    setIsSearching(false);
    loadFiles(activeProvider, currentFolder.id);
  }

  // ── Folder navigation ──────────────────────────────────────────────────────
  function openFolder(folder) {
    setFolderStack((s) => [...s, { id: folder.id, name: folder.name }]);
    setSelectedFiles(new Set());
    loadFiles(activeProvider, folder.id);
  }

  function navigateBack(index) {
    const newStack = folderStack.slice(0, index + 1);
    setFolderStack(newStack);
    setSelectedFiles(new Set());
    loadFiles(activeProvider, newStack[newStack.length - 1].id);
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function toggleFile(fileId) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      next.has(fileId) ? next.delete(fileId) : next.add(fileId);
      return next;
    });
  }

  function toggleSelectAll() {
    const selectable = files.filter((f) => !f.isFolder);
    if (selectedFiles.size === selectable.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(selectable.map((f) => f.id)));
    }
  }

  // ── Pipeline toggles ───────────────────────────────────────────────────────
  function togglePipeline(key) {
    setPipelines((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // ── Process ────────────────────────────────────────────────────────────────
  async function handleProcess() {
    if (selectedFiles.size === 0) return;
    const enabledPipelines = Object.entries(pipelines).filter(([, v]) => v).map(([k]) => k);

    setProcessing(true);
    setError(null);
    try {
      const filesToProcess = Array.from(selectedFiles).map((fileId) => ({
        fileId,
        dealId,
        contactId,
        pipelines: enabledPipelines,
      }));

      const res = await apiFetch(`/api/storage/${activeProvider}/files/batch-process`, {
        method: 'POST',
        body: JSON.stringify({ files: filesToProcess }),
      });

      setProcessingResults(res);
      if (onComplete) onComplete(res);
    } catch (e) {
      setError('Processing failed: ' + e.message);
    } finally {
      setProcessing(false);
    }
  }

  // ── Render: loading providers ──────────────────────────────────────────────
  if (loadingProviders) {
    return (
      <div className="cfp-overlay">
        <div className="cfp-modal cfp-modal--loading">
          <div className="cfp-spinner" />
          <p>Loading storage providers…</p>
        </div>
      </div>
    );
  }

  // ── Render: results ────────────────────────────────────────────────────────
  if (processingResults) {
    return (
      <div className="cfp-overlay">
        <div className="cfp-modal cfp-modal--results">
          <button className="cfp-close" onClick={onClose}>✕</button>
          <h2>Processing Complete</h2>
          <p className="cfp-results-summary">
            {processingResults.processed} of {processingResults.total} file
            {processingResults.total !== 1 ? 's' : ''} processed successfully.
          </p>
          <div className="cfp-results-list">
            {processingResults.results.map((r) => (
              <div key={r.fileId} className={`cfp-result-item cfp-result-item--${r.status}`}>
                <span className="cfp-result-icon">{r.status === 'fulfilled' ? '✅' : '❌'}</span>
                <div className="cfp-result-detail">
                  <strong>{r.result?.file?.name || r.fileId}</strong>
                  {r.result?.pipelinesRun && (
                    <span className="cfp-result-pipelines">
                      Ran: {r.result.pipelinesRun.map((p) => PIPELINE_LABELS[p] || p).join(', ')}
                    </span>
                  )}
                  {r.error && <span className="cfp-result-error">{r.error}</span>}
                </div>
              </div>
            ))}
          </div>
          <button className="cfp-btn cfp-btn--secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  const activeStatus = providerStatuses[activeProvider] || {};
  const selectableFiles = files.filter((f) => !f.isFolder);
  const allSelected = selectableFiles.length > 0 && selectedFiles.size === selectableFiles.length;

  return (
    <div className="cfp-overlay">
      <div className="cfp-modal">
        {/* Header */}
        <div className="cfp-header">
          <div className="cfp-header-left">
            <h2>Import from Cloud Storage</h2>
          </div>
          <button className="cfp-close" onClick={onClose}>✕</button>
        </div>

        {/* Provider tabs */}
        <div className="cfp-providers">
          {providers.map((p) => {
            const st = providerStatuses[p.id];
            return (
              <button
                key={p.id}
                className={`cfp-provider-tab ${activeProvider === p.id ? 'cfp-provider-tab--active' : ''} ${!st?.connected ? 'cfp-provider-tab--disconnected' : ''}`}
                onClick={() => switchProvider(p.id)}
              >
                <span className="cfp-provider-icon">{PROVIDER_ICONS[p.id] || '📦'}</span>
                <span className="cfp-provider-name">{p.displayName}</span>
                <span className={`cfp-provider-dot ${st?.connected ? 'cfp-provider-dot--on' : 'cfp-provider-dot--off'}`} />
              </button>
            );
          })}
        </div>

        {/* Not connected state */}
        {!activeStatus.connected ? (
          <div className="cfp-connect-prompt">
            <div className="cfp-connect-icon">{PROVIDER_ICONS[activeProvider] || '📦'}</div>
            <p>{activeStatus.message || `Connect ${activeProvider} to browse files.`}</p>
            {activeStatus.reauthUrl && (
              <a className="cfp-btn cfp-btn--primary" href={`${API_BASE}${activeStatus.reauthUrl}`}>
                Connect {providers.find((p) => p.id === activeProvider)?.displayName}
              </a>
            )}
          </div>
        ) : (
          <>
            {/* Breadcrumb */}
            <div className="cfp-breadcrumb">
              {folderStack.map((crumb, i) => (
                <span key={i} className="cfp-breadcrumb-item">
                  {i > 0 && <span className="cfp-breadcrumb-sep">›</span>}
                  <button
                    className={`cfp-breadcrumb-btn ${i === folderStack.length - 1 ? 'cfp-breadcrumb-btn--active' : ''}`}
                    onClick={() => i < folderStack.length - 1 && navigateBack(i)}
                    disabled={i === folderStack.length - 1}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>

            {/* Search */}
            <form className="cfp-search" onSubmit={handleSearch}>
              <input
                type="text"
                className="cfp-search-input"
                placeholder={`Search ${providers.find((p) => p.id === activeProvider)?.displayName}…`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {isSearching
                ? <button type="button" className="cfp-search-clear" onClick={clearSearch}>Clear</button>
                : <button type="submit" className="cfp-search-btn">Search</button>
              }
            </form>

            {/* File list */}
            <div className="cfp-file-list">
              {loadingFiles && (
                <div className="cfp-loading">
                  <div className="cfp-spinner cfp-spinner--sm" /><span>Loading…</span>
                </div>
              )}
              {!loadingFiles && error && <div className="cfp-error-banner">{error}</div>}
              {!loadingFiles && !error && files.length === 0 && (
                <div className="cfp-empty">
                  {isSearching ? 'No files match your search.' : 'This folder is empty.'}
                </div>
              )}
              {!loadingFiles && files.length > 0 && (
                <>
                  {selectableFiles.length > 0 && (
                    <div className="cfp-select-all">
                      <label className="cfp-checkbox-label">
                        <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                        <span>{allSelected ? 'Deselect all' : `Select all (${selectableFiles.length})`}</span>
                      </label>
                    </div>
                  )}
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className={`cfp-file-row ${file.isFolder ? 'cfp-file-row--folder' : ''} ${selectedFiles.has(file.id) ? 'cfp-file-row--selected' : ''}`}
                      onClick={() => file.isFolder ? openFolder(file) : toggleFile(file.id)}
                    >
                      {!file.isFolder && (
                        <input
                          type="checkbox"
                          className="cfp-file-checkbox"
                          checked={selectedFiles.has(file.id)}
                          onChange={() => toggleFile(file.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                      <span className="cfp-file-icon">{FILE_ICONS[file.category] || '📄'}</span>
                      <div className="cfp-file-info">
                        <span className="cfp-file-name">{file.name}</span>
                        <span className="cfp-file-meta">
                          {file.isFolder
                            ? `${file.childCount ?? '—'} items`
                            : file.isGoogleNative
                              ? `Google ${file.category} · ${formatDate(file.lastModified)}`
                              : `${formatFileSize(file.size)} · ${formatDate(file.lastModified)}`
                          }
                        </span>
                      </div>
                      {file.isFolder && <span className="cfp-folder-arrow">›</span>}
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Pipeline toggles */}
            {selectedFiles.size > 0 && (
              <div className="cfp-pipelines">
                <p className="cfp-pipelines-label">Process with:</p>
                <div className="cfp-pipelines-grid">
                  {Object.entries(PIPELINE_LABELS).map(([key, label]) => (
                    <label key={key} className="cfp-pipeline-toggle">
                      <input type="checkbox" checked={!!pipelines[key]} onChange={() => togglePipeline(key)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="cfp-footer">
          <span className="cfp-selection-count">
            {selectedFiles.size > 0
              ? `${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''} selected`
              : 'No files selected'}
          </span>
          <div className="cfp-footer-actions">
            <button className="cfp-btn cfp-btn--secondary" onClick={onClose} disabled={processing}>
              Cancel
            </button>
            <button
              className="cfp-btn cfp-btn--primary"
              onClick={handleProcess}
              disabled={selectedFiles.size === 0 || processing || !activeStatus.connected}
            >
              {processing
                ? `Processing…`
                : `Import & Process${selectedFiles.size > 0 ? ` (${selectedFiles.size})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('authToken');
  const res = await fetch(`${API_BASE}${path}`, {
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
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
