import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

// ═══════════════════════════════════════════════════════════════════
// OAEmailSettings.js
// Data Quality → Email Settings
//
// Manages the org's email filter configuration:
//   - Platform default blocked domains/patterns (read-only display)
//   - Org-specific additions (add/remove)
//   - Internal domain visibility
//   - Account domain coverage + auto-derive tool
// ═══════════════════════════════════════════════════════════════════

// ─── Tag list editor ──────────────────────────────────────────────────────────

function TagListEditor({ items, onAdd, onRemove, placeholder, disabled }) {
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const val = input.trim().toLowerCase();
    if (!val || items.includes(val)) { setInput(''); return; }
    onAdd(val);
    setInput('');
  };

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {items.map(item => (
          <span key={item} style={styles.tag}>
            {item}
            {!disabled && (
              <button style={styles.tagRemove} onClick={() => onRemove(item)}>×</button>
            )}
          </span>
        ))}
        {items.length === 0 && (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>None added</span>
        )}
      </div>
      {!disabled && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={styles.input}
            placeholder={placeholder}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button style={styles.addBtn} onClick={handleAdd}>Add</button>
        </div>
      )}
    </div>
  );
}

// ─── Platform defaults display ────────────────────────────────────────────────

function PlatformDefaultsPanel({ defaults }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={styles.platformBox}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={styles.platformBadge}>Platform</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
            Default blocked senders
          </span>
        </div>
        <button style={styles.expandBtn} onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Hide' : 'Show'} defaults
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 0' }}>
        These are managed by ActionCRM and applied to all organisations.
        Your additions below are applied on top of these.
      </p>
      {expanded && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={styles.subLabel}>Blocked domains</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {(defaults.blocked_domains || []).map(d => (
                <span key={d} style={{ ...styles.tag, background: '#f1f5f9', color: '#64748b' }}>{d}</span>
              ))}
            </div>
          </div>
          <div>
            <div style={styles.subLabel}>Blocked sender patterns</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {(defaults.blocked_local_patterns || []).map(p => (
                <span key={p} style={{ ...styles.tag, background: '#f1f5f9', color: '#64748b' }}>{p}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Filter Log tab ───────────────────────────────────────────────────────────

const REASON_META = {
  automated_sender:          { label: 'Automated sender',        color: '#dc2626', bg: '#fef2f2' },
  internal_no_crm_reference: { label: 'Internal — no CRM match', color: '#d97706', bg: '#fffbeb' },
  no_crm_match:              { label: 'No CRM match',            color: '#6b7280', bg: '#f3f4f6' },
};

function FilterLogTab() {
  const [logs,     setLogs]     = useState([]);
  const [total,    setTotal]    = useState(0);
  const [pages,    setPages]    = useState(1);
  const [page,     setPage]     = useState(1);
  const [reason,   setReason]   = useState('');
  const [provider, setProvider] = useState('');
  const [loading,  setLoading]  = useState(true);
  const [purging,  setPurging]  = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiService.orgAdmin.getEmailFilterLog({
        page, limit: 25,
        ...(reason   ? { reason }   : {}),
        ...(provider ? { provider } : {}),
      });
      setLogs(r.data.logs   || []);
      setTotal(r.data.total || 0);
      setPages(r.data.pages || 1);
    } catch { setError('Failed to load filter log'); }
    finally { setLoading(false); }
  }, [page, reason, provider]);

  useEffect(() => { load(); }, [load]);

  const handleFilterChange = (setter) => (e) => { setter(e.target.value); setPage(1); };

  const handlePurge = async () => {
    if (!window.confirm('Purge all filter log entries for this organisation? This cannot be undone.')) return;
    setPurging(true);
    try {
      const r = await apiService.orgAdmin.purgeEmailFilterLog();
      setSuccess(`Purged ${r.data.deleted} log entries ✓`);
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch { setError('Failed to purge log'); }
    finally { setPurging(false); }
  };

  return (
    <div>
      {error   && <div style={styles.errLine}>⚠️ {error}</div>}
      {success && <div style={styles.successLine}>✓ {success}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={styles.filterSelect} value={reason} onChange={handleFilterChange(setReason)}>
          <option value="">All reasons</option>
          <option value="automated_sender">Automated sender</option>
          <option value="internal_no_crm_reference">Internal — no CRM match</option>
          <option value="no_crm_match">No CRM match</option>
        </select>
        <select style={styles.filterSelect} value={provider} onChange={handleFilterChange(setProvider)}>
          <option value="">All providers</option>
          <option value="outlook">Outlook</option>
          <option value="gmail">Gmail</option>
        </select>
        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 4 }}>
          {total.toLocaleString()} filtered email{total !== 1 ? 's' : ''} in last 30 days
        </span>
        <button
          style={{ ...styles.cancelBtn, marginLeft: 'auto', color: '#dc2626', borderColor: '#fca5a5' }}
          onClick={handlePurge}
          disabled={purging || total === 0}
        >
          {purging ? 'Purging…' : 'Purge log'}
        </button>
      </div>

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
      ) : logs.length === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: '#9ca3af' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>No filtered emails</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            {reason || provider ? 'No entries match this filter.' : 'Filter log is empty — all synced emails passed through.'}
          </div>
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                  {['Date', 'From', 'Subject', 'Reason', 'Provider'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const meta = REASON_META[log.reason] || { label: log.reason, color: '#6b7280', bg: '#f3f4f6' };
                  return (
                    <tr key={log.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '7px 10px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {new Date(log.sync_date).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td style={{ padding: '7px 10px', color: '#374151', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {log.from_address || '—'}
                      </td>
                      <td style={{ padding: '7px 10px', color: '#374151', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {log.subject || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(no subject)</span>}
                      </td>
                      <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg, borderRadius: 5, padding: '2px 7px' }}>
                          {meta.label}
                        </span>
                      </td>
                      <td style={{ padding: '7px 10px', color: '#9ca3af', textTransform: 'capitalize' }}>
                        {log.provider || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14 }}>
            <button style={styles.pageBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Page {page} of {pages}</span>
            <button style={styles.pageBtn} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OAEmailSettings() {
  const [activeTab, setActiveTab] = useState('settings');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');

  // Editable state — org-specific additions only
  const [orgDomains,   setOrgDomains]   = useState([]);
  const [orgPatterns,  setOrgPatterns]  = useState([]);
  const [dirty,        setDirty]        = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiService.orgAdmin.getEmailSettings();
      setData(r.data);
      setOrgDomains(r.data.org_blocked_domains    || []);
      setOrgPatterns(r.data.org_blocked_patterns   || []);
      setDirty(false);
    } catch (e) {
      setError('Failed to load email settings');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await apiService.orgAdmin.updateEmailSettings({
        blocked_domains:        orgDomains,
        blocked_local_patterns: orgPatterns,
      });
      setSuccess('Email filter settings saved ✓');
      setTimeout(() => setSuccess(''), 3000);
      setDirty(false);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to save');
    } finally { setSaving(false); }
  };

  const addDomain  = (d) => { setOrgDomains(prev => [...prev, d]);  setDirty(true); };
  const rmDomain   = (d) => { setOrgDomains(prev => prev.filter(x => x !== d)); setDirty(true); };
  const addPattern = (p) => { setOrgPatterns(prev => [...prev, p]); setDirty(true); };
  const rmPattern  = (p) => { setOrgPatterns(prev => prev.filter(x => x !== p)); setDirty(true); };

  if (loading) return <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading email settings…</div>;

  const TABS = [
    { id: 'settings', label: '⚙️ Filter Settings' },
    { id: 'log',      label: '📋 Filter Log'      },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '7px 16px',
              borderRadius: '7px 7px 0 0',
              border: '1px solid transparent',
              borderBottom: 'none',
              background: activeTab === t.id ? '#fff' : 'transparent',
              borderColor: activeTab === t.id ? '#e5e7eb' : 'transparent',
              borderBottomColor: activeTab === t.id ? '#fff' : 'transparent',
              fontSize: 13,
              fontWeight: activeTab === t.id ? 600 : 500,
              color: activeTab === t.id ? '#111827' : '#6b7280',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter Log tab */}
      {activeTab === 'log' && <FilterLogTab />}

      {/* Settings tab */}
      {activeTab === 'settings' && <>
      {error   && <div style={styles.errLine}>⚠️ {error}</div>}
      {success && <div style={styles.successLine}>✓ {success}</div>}

      {/* How it works */}
      <div style={styles.infoBanner}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1e40af', marginBottom: 4 }}>
          How email filtering works
        </div>
        <div style={{ fontSize: 12, color: '#1e40af', lineHeight: 1.6 }}>
          When emails sync from Outlook or Gmail, each email passes through four checks in order:
          <br />
          <strong>1. Automated sender check</strong> — drops system notifications, marketing emails, noreply addresses (platform defaults + your additions below)
          <br />
          <strong>2. Internal-only check</strong> — emails between team members are kept only if the subject mentions a deal or account name
          <br />
          <strong>3. CRM match</strong> — matched against contacts, prospects, and account domains in priority order
          <br />
          <strong>4. No match</strong> — dropped (not stored)
        </div>
      </div>

      {/* Internal domains */}
      {data?.internal_domains?.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Your organisation's internal domains</div>
          <p style={styles.sectionDesc}>
            Derived from your team members' email addresses. Emails between these domains are treated as internal.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.internal_domains.map(d => (
              <span key={d} style={{ ...styles.tag, background: '#eff6ff', color: '#1d4ed8', borderColor: '#bfdbfe' }}>{d}</span>
            ))}
          </div>
        </div>
      )}

      {/* Platform defaults */}
      {data?.platform_defaults && (
        <div style={styles.section}>
          <PlatformDefaultsPanel defaults={data.platform_defaults} />
        </div>
      )}

      {/* Org-specific blocked domains */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Additional blocked domains</div>
        <p style={styles.sectionDesc}>
          Add domains you never want to sync emails from — e.g. your own marketing automation platform,
          billing system, or HR tools. These are in addition to the platform defaults above.
        </p>
        <TagListEditor
          items={orgDomains}
          onAdd={addDomain}
          onRemove={rmDomain}
          placeholder="e.g. hubspot.com or mailchimp.com"
        />
      </div>

      {/* Org-specific blocked patterns */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Additional blocked sender patterns</div>
        <p style={styles.sectionDesc}>
          Block email addresses where the local part (before the @) matches this pattern.
          For example, adding <code>billing</code> will block billing@anycompany.com.
        </p>
        <TagListEditor
          items={orgPatterns}
          onAdd={addPattern}
          onRemove={rmPattern}
          placeholder="e.g. alerts or billing"
        />
      </div>

      {/* Save */}
      {dirty && (
        <div style={{ paddingTop: 16, borderTop: '1px solid #f3f4f6', display: 'flex', gap: 8 }}>
          <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save filter settings'}
          </button>
          <button style={styles.cancelBtn} onClick={() => {
            setOrgDomains(data?.org_blocked_domains   || []);
            setOrgPatterns(data?.org_blocked_patterns || []);
            setDirty(false);
          }}>
            Discard changes
          </button>
        </div>
      )}

      {/* Account domain coverage */}
      {data?.account_domain_coverage && (
        <AccountDomainPanelWithCoverage coverage={data.account_domain_coverage} />
      )}
      </>}
    </div>
  );
}

// Wrapper that passes coverage data down
function AccountDomainPanelWithCoverage({ coverage }) {
  const [suggestions,  setSuggestions]  = useState([]);
  const [selected,     setSelected]     = useState({});
  const [loading,      setLoading]      = useState(false);
  const [applying,     setApplying]     = useState(false);
  const [success,      setSuccess]      = useState('');
  const [error,        setError]        = useState('');

  const loadSuggestions = async () => {
    setLoading(true); setError('');
    try {
      const r = await apiService.orgAdmin.deriveAccountDomains();
      setSuggestions(r.data.suggestions || []);
      const preselect = {};
      (r.data.suggestions || []).forEach(s => { if (s.suggested_domain) preselect[s.id] = true; });
      setSelected(preselect);
    } catch { setError('Failed to load suggestions'); }
    finally { setLoading(false); }
  };

  const handleApply = async () => {
    const updates = suggestions
      .filter(s => selected[s.id] && s.suggested_domain)
      .map(s => ({ id: s.id, domain: s.suggested_domain }));
    if (!updates.length) return;
    setApplying(true); setError('');
    try {
      const r = await apiService.orgAdmin.applyAccountDomains(updates);
      setSuccess(`Applied ${r.data.applied} domain${r.data.applied !== 1 ? 's' : ''} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      setSuggestions([]); setSelected({});
    } catch { setError('Failed to apply domains'); }
    finally { setApplying(false); }
  };

  const pct = coverage.total > 0 ? Math.round((coverage.have_domain / coverage.total) * 100) : 100;

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Account domain coverage</div>
      <p style={styles.sectionDesc}>
        Domains on account records match incoming emails when no contact match is found.
        Accounts missing a domain won't catch emails from new contacts at that company.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 6, height: 8, overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%', borderRadius: 6, transition: 'width 0.4s',
            background: pct === 100 ? '#059669' : pct > 70 ? '#f59e0b' : '#dc2626',
          }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', flexShrink: 0 }}>
          {coverage.have_domain}/{coverage.total} ({pct}%)
        </span>
      </div>

      {error   && <div style={styles.errLine}>{error}</div>}
      {success && <div style={styles.successLine}>{success}</div>}

      {coverage.missing_domain > 0 && suggestions.length === 0 && (
        <button style={styles.secondaryBtn} onClick={loadSuggestions} disabled={loading}>
          {loading ? 'Scanning contacts…' : `Auto-derive domains for ${coverage.missing_domain} account${coverage.missing_domain !== 1 ? 's' : ''} missing a domain`}
        </button>
      )}

      {suggestions.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
            Review and select which domains to apply:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
            {suggestions.map(s => (
              <label key={s.id} style={styles.suggestionRow}>
                <input
                  type="checkbox"
                  checked={!!selected[s.id]}
                  onChange={e => setSelected(p => ({ ...p, [s.id]: e.target.checked }))}
                  disabled={!s.suggested_domain}
                />
                <span style={{ flex: 1, fontSize: 13, color: '#111827' }}>{s.account_name}</span>
                {s.suggested_domain
                  ? <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>{s.suggested_domain}</span>
                  : <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>no email contacts</span>
                }
                <span style={{ fontSize: 11, color: '#9ca3af' }}>({s.contact_count} contact{s.contact_count !== 1 ? 's' : ''})</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.saveBtn} onClick={handleApply} disabled={applying || !Object.values(selected).some(Boolean)}>
              {applying ? 'Applying…' : 'Apply selected'}
            </button>
            <button style={styles.cancelBtn} onClick={() => { setSuggestions([]); setSelected({}); }}>Cancel</button>
          </div>
        </>
      )}

      {coverage.missing_domain === 0 && (
        <div style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>✓ All accounts have a domain</div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  infoBanner: {
    background: '#eff6ff',
    border: '1px solid #bfdbfe',
    borderRadius: 9,
    padding: '14px 16px',
    marginBottom: 20,
  },
  section: {
    borderTop: '1px solid #f3f4f6',
    paddingTop: 18,
    marginTop: 18,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: '#6b7280',
    marginBottom: 6,
  },
  sectionDesc: {
    fontSize: 12,
    color: '#6b7280',
    margin: '0 0 12px',
    lineHeight: 1.5,
  },
  subLabel: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#9ca3af',
    marginBottom: 4,
  },
  platformBox: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 9,
    padding: '12px 14px',
  },
  platformBadge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    color: '#6366f1',
    background: '#eef2ff',
    borderRadius: 5,
    padding: '2px 7px',
  },
  expandBtn: {
    padding: '3px 10px',
    borderRadius: 5,
    border: '1px solid #e2e8f0',
    background: '#fff',
    fontSize: 11,
    color: '#6b7280',
    cursor: 'pointer',
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    background: '#f3f4f6',
    color: '#374151',
    borderRadius: 5,
    padding: '3px 8px',
    border: '1px solid #e5e7eb',
  },
  tagRemove: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#9ca3af',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  input: {
    flex: 1,
    padding: '6px 10px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 12,
  },
  addBtn: {
    padding: '6px 14px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    background: '#fff',
    fontSize: 12,
    cursor: 'pointer',
    color: '#374151',
  },
  saveBtn: {
    padding: '7px 18px',
    borderRadius: 7,
    border: 'none',
    background: '#6366f1',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '7px 14px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    background: '#fff',
    fontSize: 13,
    color: '#374151',
    cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '7px 16px',
    borderRadius: 7,
    border: '1px solid #c7d2fe',
    background: '#eef2ff',
    color: '#6366f1',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  errLine: {
    fontSize: 12,
    color: '#dc2626',
    background: '#fef2f2',
    borderRadius: 6,
    padding: '5px 10px',
    marginBottom: 8,
  },
  successLine: {
    fontSize: 12,
    color: '#059669',
    background: '#f0fdf4',
    borderRadius: 6,
    padding: '5px 10px',
    marginBottom: 8,
  },
  suggestionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 7,
    cursor: 'pointer',
    fontSize: 12,
  },
  filterSelect: {
    padding: '6px 10px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 12,
    background: '#fff',
    color: '#374151',
  },
  pageBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
  },
};
