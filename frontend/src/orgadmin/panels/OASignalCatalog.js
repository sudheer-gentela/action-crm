/* Signal-Based Campaigns — Phase 4: Signal Catalog panel (Settings → Prospecting → Signals).
 *
 * The org-shared catalog home (design §4, D10): browse/edit/retire/add signals
 * deliberately. Table columns: Signal (resolved for the selected function),
 * Capability (rep word: Filter/Prioritize/Both), Function(s), and — in the admin
 * view only — Reliability + Source (hidden from reps everywhere else, D9).
 *
 * Role-relative signals (scope=target_role) render a placeholder chip and
 * resolve live against the function selector ("New {leader} in seat" →
 * "New CFO in seat"). Rep-added signals are tagged.
 *
 * Create is rep-simple: plain questions only (label, Filter/Prioritize/Both,
 * company vs target role, function(s), optional predicate). Type/reliability/
 * source are inferred server-side (createRepSignal) and never asked.
 *
 * Matches the existing OA panel conventions (raw fetch + REACT_APP_API_URL +
 * flash). Styling is self-contained in OASignalCatalog.css (sc-* namespace).
 */
import React, { useState, useEffect } from 'react';
import './OASignalCatalog.css';

const CAPABILITY_LABEL = { filter: 'Filter', prioritize: 'Prioritize', both: 'Both' };
const CAPABILITY_HINT = {
  filter: 'Must be true to be in the pool.',
  prioritize: 'Ranks higher / picks the angle — excludes nobody.',
  both: 'Can be used either way per campaign.',
};
const SCOPE_LABEL = { company: 'The company', target_role: 'The target role' };
const PREDICATE_LABEL = {
  boolean: 'Yes / no', set: 'One of a list', number: 'A number',
  recency: 'How recently', geo: 'A location',
};

export default function OASignalCatalog() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [signals, setSignals]     = useState([]);
  const [functions, setFunctions] = useState([]);
  const [functionKey, setFunctionKey] = useState('');   // '' = show raw placeholders
  const [loading, setLoading]     = useState(true);
  const [flash, setFlash]         = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const showFlash = (type, msg) => { setFlash({ type, msg }); setTimeout(() => setFlash(null), 4000); };

  const load = async (fnKey = functionKey) => {
    try {
      const qs = fnKey ? `?admin=true&function=${encodeURIComponent(fnKey)}` : '?admin=true';
      const [sig, fns] = await Promise.all([
        fetch(`${API}/signal-catalog${qs}`, { headers }).then(r => r.json()),
        fetch(`${API}/signal-catalog/functions`, { headers }).then(r => r.json()),
      ]);
      setSignals(sig.signals || []);
      setFunctions(fns.functions || []);
    } catch {
      showFlash('error', 'Failed to load the signal catalog');
    }
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFunctionChange = (key) => { setFunctionKey(key); load(key); };

  const retire = async (key) => {
    if (!window.confirm(`Retire "${key}"? It stays on campaigns already using it, but can't be added to new ones.`)) return;
    try {
      const r = await fetch(`${API}/signal-catalog/${encodeURIComponent(key)}`, { method: 'DELETE', headers });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Failed'); }
      showFlash('success', `Retired "${key}"`);
      load();
    } catch (e) { showFlash('error', e.message); }
  };

  if (loading) return <div className="sc-panel"><p>Loading signals…</p></div>;

  return (
    <div className="sc-panel">
      <div className="sc-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h3 className="sc-title">Signals</h3>
          <p className="sc-desc">
            The shared library your team targets and prioritizes on. Everyone in the org sees the
            same signals; anything added here is available to every campaign.
          </p>
        </div>
        <button className="sc-btn sc-btn--primary" onClick={() => setShowCreate(true)}>+ Create signal</button>
      </div>

      {flash && (
        <div className={`sc-flash sc-flash-${flash.type}`} style={{ margin: '8px 0' }}>{flash.msg}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' }}>
        <label style={{ fontSize: 12, color: '#6b7280' }}>Preview role-relative signals for:</label>
        <select value={functionKey} onChange={e => onFunctionChange(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">Show placeholders</option>
          {functions.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>

      {signals.length === 0 ? (
        <div className="sc-empty">
          <p>No signals yet. Create your first — a funding raise, a job change, a tech install —
             and it becomes available to every campaign's targeting.</p>
        </div>
      ) : (
        <table className="sc-table">
          <thead>
            <tr>
              <th>Signal</th>
              <th>Capability</th>
              <th>Function(s)</th>
              <th>Reliability</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {signals.map(s => (
              <tr key={s.key}>
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {s.resolvedLabel || s.label}
                    {s.isRoleRelative && !functionKey && (
                      <span className="sc-chip sc-chip--muted" title="Resolves per function">role-relative</span>
                    )}
                    {s.repAdded && <span className="sc-chip sc-chip--info" title="Added by a rep">rep-added</span>}
                  </div>
                  {s.description && <div style={{ fontSize: 12, color: '#6b7280' }}>{s.description}</div>}
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.key}</div>
                </td>
                <td>
                  <span title={CAPABILITY_HINT[s.capability]}>{CAPABILITY_LABEL[s.capability] || s.capability}</span>
                </td>
                <td>
                  {(!s.functionTags || s.functionTags.length === 0)
                    ? <span style={{ color: '#6b7280' }}>Any</span>
                    : s.functionTags.map(t => <span key={t} className="sc-chip">{functionLabel(functions, t)}</span>)}
                </td>
                <td><ReliabilityBadge value={s.reliability} /></td>
                <td style={{ fontSize: 12, color: '#6b7280' }}>{sourceLabel(s.sourceKind)}</td>
                <td style={{ textAlign: 'right' }}>
                  {s.active !== false && (
                    <button className="sc-btn-link sc-btn-link--danger" onClick={() => retire(s.key)}>Retire</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <CreateSignalModal
          API={API}
          headers={headers}
          functions={functions}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); showFlash('success', 'Signal created'); load(); }}
        />
      )}
    </div>
  );
}

function functionLabel(functions, key) {
  const f = functions.find(x => x.key === key);
  return f ? f.label : key;
}
function functionLabelLocal(functions, key) {
  const f = (functions || []).find(x => x.key === key);
  return f ? f.label : key;
}
function sourceLabel(kind) {
  return ({ list: 'List / import', enrich: 'Enrichment', harvest: 'Page capture',
    dataset: 'Dataset', rep_validate: 'Confirmed while working' })[kind] || kind || '—';
}
function ReliabilityBadge({ value }) {
  const color = value === 'high' ? '#059669' : value === 'medium' ? '#d97706' : '#9ca3af';
  return <span style={{ color, fontWeight: 600, fontSize: 12, textTransform: 'capitalize' }}>{value || '—'}</span>;
}

// ── Rep-simple create modal ──────────────────────────────────────────────────
// Plain questions only. No type/reliability/source — inferred server-side.
function CreateSignalModal({ API, headers, functions, onClose, onCreated }) {
  const [label, setLabel]           = useState('');
  const [description, setDesc]      = useState('');
  const [capability, setCapability] = useState('prioritize');
  const [scope, setScope]           = useState('company');
  const [predicateType, setPred]    = useState('boolean');
  const [tags, setTags]             = useState([]);      // function keys; [] = Any
  const [defaultHook, setHook]      = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');
  // Light Inference (Q-B): suggestion surfaced when the typed label embeds a
  // recognized role title. The rep confirms — never auto-applied.
  const [suggestion, setSuggestion] = useState(null);
  const [dismissedSuggestion, setDismissed] = useState(false);

  // Ask the server to analyze the label for an embedded role title.
  const runInference = async (text) => {
    if (!text || !text.trim() || /\{(leader|head|team|hire|tool)\}/i.test(text)) { setSuggestion(null); return; }
    try {
      const r = await fetch(`${API}/signal-catalog/infer-role`, {
        method: 'POST', headers, body: JSON.stringify({ label: text }),
      }).then(x => x.json());
      setSuggestion(r.suggestion && r.suggestion.hasSuggestion ? r.suggestion : null);
    } catch { setSuggestion(null); }
  };

  const applySuggestion = (fnKey) => {
    if (!suggestion) return;
    setLabel(suggestion.tokenizedLabel);
    setScope('target_role');                 // role-relative by definition
    if (fnKey) setTags(prev => prev.includes(fnKey) ? prev : [...prev, fnKey]);
    setSuggestion(null);
    setDismissed(true);
  };

  // Derive a stable key from the label (lowercase snake). Reps never type keys.
  const derivedKey = label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)
    .replace(/^([0-9])/, 's_$1');   // must start with a letter

  const toggleTag = (key) => setTags(prev => prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key]);

  const submit = async () => {
    if (!label.trim()) { setError('Describe what you\'re looking for.'); return; }
    if (!derivedKey) { setError('That name doesn\'t produce a valid key — add some letters.'); return; }
    setBusy(true); setError('');
    try {
      const body = {
        key: derivedKey, label: label.trim(), description: description || null,
        capability, scope, predicate_type: predicateType,
        function_tags: tags, default_hook: defaultHook || null,
      };
      const r = await fetch(`${API}/signal-catalog`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Create failed'); }
      onCreated();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const isRoleRelative = scope === 'target_role';

  return (
    <div className="sc-modal-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Create a signal</h3>
          <button className="sc-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="sc-modal-body">
          <label className="sc-field-label">What are you looking for?</label>
          <input
            autoFocus placeholder={isRoleRelative ? 'e.g. New {leader} in seat' : 'e.g. Recently raised funding'}
            value={label}
            onChange={e => { setLabel(e.target.value); setDismissed(false); }}
            onBlur={e => { if (!dismissedSuggestion) runInference(e.target.value); }}
          />
          {suggestion && !dismissedSuggestion && (
            <div className="sc-suggest">
              <div className="sc-suggest-head">
                Looks like this is about the <strong>{suggestion.role}</strong> — make it work across
                functions?
              </div>
              <div className="sc-suggest-body">
                We'd save it as <code>{suggestion.tokenizedLabel}</code>, which reads:
                <ul className="sc-suggest-preview">
                  {Object.entries(suggestion.preview).map(([fk, txt]) => (
                    <li key={fk}><span className="sc-suggest-fn">{functionLabelLocal(functions, fk)}:</span> {txt}</li>
                  ))}
                </ul>
              </div>
              <div className="sc-suggest-actions">
                {suggestion.ambiguous
                  ? suggestion.functions.map(fk => (
                      <button key={fk} type="button" className="sc-btn sc-btn--secondary" onClick={() => applySuggestion(fk)}>
                        Use for {functionLabelLocal(functions, fk)}
                      </button>
                    ))
                  : <button type="button" className="sc-btn sc-btn--primary" onClick={() => applySuggestion(suggestion.functions[0])}>
                      Yes, make it flexible
                    </button>}
                <button type="button" className="sc-btn-link" onClick={() => { setSuggestion(null); setDismissed(true); }}>
                  Keep it exactly as typed
                </button>
              </div>
            </div>
          )}
          {isRoleRelative && (
            <p className="sc-hint">
              Use {'{leader}'}, {'{head}'}, {'{team}'}, {'{hire}'} or {'{tool}'} and it resolves per
              function — "New {'{leader}'} in seat" reads "New CFO in seat" for finance.
            </p>
          )}

          <label className="sc-field-label">Add a short description (optional)</label>
          <input value={description} onChange={e => setDesc(e.target.value)} placeholder="What it means, in your words" />

          <label className="sc-field-label">How should it be used?</label>
          <div className="sc-radio-row">
            {['filter', 'prioritize', 'both'].map(c => (
              <button
                key={c} type="button"
                className={'sc-radio-card' + (capability === c ? ' is-selected' : '')}
                onClick={() => setCapability(c)}
              >
                <span className="sc-radio-title">{CAPABILITY_LABEL[c]}</span>
                <span className="sc-radio-hint">{CAPABILITY_HINT[c]}</span>
              </button>
            ))}
          </div>
          {capability !== 'prioritize' && (
            <p className="sc-hint sc-hint--warn">
              Heads up — some signals can only ever prioritize (never filter) once we see how
              dependable the data is. If so, we'll switch this to Prioritize automatically.
            </p>
          )}

          <label className="sc-field-label">Is it about the company, or the target role?</label>
          <div className="sc-radio-row">
            {['company', 'target_role'].map(sc => (
              <button
                key={sc} type="button"
                className={'sc-radio-card' + (scope === sc ? ' is-selected' : '')}
                onClick={() => setScope(sc)}
              >
                <span className="sc-radio-title">{SCOPE_LABEL[sc]}</span>
              </button>
            ))}
          </div>

          <label className="sc-field-label">Which function(s)? <span style={{ color: '#9ca3af' }}>(none = any)</span></label>
          <div className="sc-tag-row">
            {functions.map(f => (
              <button
                key={f.key} type="button"
                className={'sc-tag' + (tags.includes(f.key) ? ' is-selected' : '')}
                onClick={() => toggleTag(f.key)}
              >{f.label}</button>
            ))}
          </div>

          <label className="sc-field-label">What kind of answer is it?</label>
          <select value={predicateType} onChange={e => setPred(e.target.value)}>
            {Object.entries(PREDICATE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>

          <label className="sc-field-label">Why-now hook (optional)</label>
          <input value={defaultHook} onChange={e => setHook(e.target.value)}
            placeholder="e.g. Fresh capital usually means new tooling budgets." />

          {derivedKey && <p className="sc-hint">Saved as <code>{derivedKey}</code>.</p>}
          {error && <div className="sc-flash sc-flash--error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn sc-btn--secondary" onClick={onClose}>Cancel</button>
          <button className="sc-btn sc-btn--primary" disabled={busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create signal'}
          </button>
        </div>
      </div>
    </div>
  );
}
