/**
 * ActionContextPanel.js
 *
 * Floating right-side panel that appears when a user clicks "Start" on a
 * calendar action. Persists across tab navigation. Shows:
 *   1. Action context (what, why, who)
 *   2. "Go there" navigation button → takes user to the relevant screen
 *   3. AI-generated suggestion (email draft, talking points, agenda, etc.)
 *
 * Props:
 *   action        — the action object from CalendarView
 *   onClose       — () => void
 *   onNavigate    — (tabId) => void  — changes the main tab
 */

import React, { useState, useEffect, useRef } from 'react';
import './ActionContextPanel.css';

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
  }).then(async r => {
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error?.message || r.statusText);
    }
    return r.json();
  });
}

// ── Action type → destination mapping ──────────────────────────
// Priority order: action_type/type FIRST (structural intent),
// then next_step (channel hint), then fallbacks.
// This prevents next_step:'email' on a meeting_schedule from routing
// to the Email tab — the type always wins.
function resolveDestination(action) {
  // Normalise — backend returns camelCase from mapActionRow on getAll,
  // but PATCH /status returns snake_case. Handle both defensively.
  const type     = (action.actionType || action.action_type || action.type || '').toLowerCase();
  const nextStep = (action.nextStep   || action.next_step   || '').toLowerCase();
  const dealId   = action.deal?.id   || action.dealId   || action.deal_id   || null;
  const contactId= action.contact?.id|| action.contactId|| action.contact_id|| null;

  // ── Type-first routing (structural intent wins) ──────────────
  // Meeting scheduling → Calendar
  if (type === 'meeting_schedule' || type === 'meeting')
    return { tab: 'calendar', label: 'Schedule Meeting', icon: '📅' };

  // Meeting prep / review → Deal detail (to review meeting notes)
  if (type === 'meeting_prep' || type === 'review')
    return { tab: 'deals', label: 'Open Deal', icon: '💼' };

  // Document prep → Files
  if (type === 'document_prep' || type === 'document')
    return { tab: 'files', label: 'Open Files', icon: '📁' };

  // Email send → Email compose
  if (type === 'email_send' || type === 'email')
    return { tab: 'email', label: 'Open Email', icon: '✉️' };

  // Follow-up: use next_step channel to decide
  if (type === 'follow_up') {
    if (nextStep === 'linkedin') return { tab: 'contacts', label: 'Open Contacts', icon: '🔗' };
    if (nextStep === 'email')    return { tab: 'email',    label: 'Open Email',    icon: '✉️' };
    // call / whatsapp / slack → Deal (no separate tab yet)
    if (dealId)  return { tab: 'deals', label: 'Open Deal', icon: '📞' };
    if (contactId) return { tab: 'contacts', label: 'Open Contacts', icon: '👥' };
    return { tab: 'deals', label: 'Open Deal', icon: '💼' };
  }

  // Task / internal → Deal if we have one, else Actions
  if (type === 'task_complete' || type === 'task' || type === 'internal_task')
    return dealId ? { tab: 'deals', label: 'Open Deal', icon: '💼' }
                  : { tab: 'actions', label: 'Open Actions', icon: '🎯' };

  // ── next_step fallback for unknown types ─────────────────────
  if (nextStep === 'email')    return { tab: 'email',    label: 'Open Email',    icon: '✉️' };
  if (nextStep === 'linkedin') return { tab: 'contacts', label: 'Open Contacts', icon: '🔗' };
  if (nextStep === 'document') return { tab: 'files',    label: 'Open Files',    icon: '📁' };

  // ── Final fallback ───────────────────────────────────────────
  if (dealId)    return { tab: 'deals',    label: 'Open Deal',     icon: '💼' };
  if (contactId) return { tab: 'contacts', label: 'Open Contacts', icon: '👥' };
  return { tab: 'deals', label: 'Open Deal', icon: '💼' };
}

// ── Priority colours ───────────────────────────────────────────
const PRIORITY_COLORS = {
  critical: { bg: '#fdf2f8', border: '#9d174d', text: '#9d174d' },
  high:     { bg: '#fee2e2', border: '#dc2626', text: '#991b1b' },
  medium:   { bg: '#fef3c7', border: '#d97706', text: '#92400e' },
  low:      { bg: '#d1fae5', border: '#059669', text: '#065f46' },
};

const NEXT_STEP_ICONS = {
  email:         '✉️',
  call:          '📞',
  whatsapp:      '💬',
  linkedin:      '🔗',
  slack:         '💬',
  document:      '📄',
  internal_task: '📋',
};

// ── Copy button ────────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className="acp-copy-btn" onClick={copy} title="Copy to clipboard">
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}

// ── AI Suggestion renderer ─────────────────────────────────────
function AISuggestion({ suggestion, loading, error, onRegenerate }) {
  if (loading) {
    return (
      <div className="acp-ai-section">
        <div className="acp-ai-header">
          <span className="acp-ai-badge">✦ AI Suggestion</span>
        </div>
        <div className="acp-ai-loading">
          <div className="acp-ai-skeleton"></div>
          <div className="acp-ai-skeleton short"></div>
          <div className="acp-ai-skeleton"></div>
          <div className="acp-ai-skeleton medium"></div>
          <p className="acp-ai-loading-label">Analysing interaction history…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="acp-ai-section">
        <div className="acp-ai-header">
          <span className="acp-ai-badge">✦ AI Suggestion</span>
          <button className="acp-regenerate" onClick={onRegenerate}>↻ Retry</button>
        </div>
        <div className="acp-ai-error">
          <p>Could not generate suggestion. {error}</p>
        </div>
      </div>
    );
  }

  if (!suggestion) return null;

  const { type, confidence } = suggestion;
  const confidencePct = Math.round((confidence || 0) * 100);

  return (
    <div className="acp-ai-section">
      <div className="acp-ai-header">
        <span className="acp-ai-badge">✦ AI Suggestion</span>
        <div className="acp-ai-meta">
          {confidence && (
            <span className="acp-confidence" title={`${confidencePct}% confidence based on interaction history`}>
              {confidencePct}% match
            </span>
          )}
          <button className="acp-regenerate" onClick={onRegenerate} title="Regenerate suggestion">↻</button>
        </div>
      </div>

      {/* EMAIL DRAFT */}
      {type === 'email' && (
        <div className="acp-suggestion-email">
          {suggestion.subject && (
            <div className="acp-email-subject">
              <span className="acp-field-label">Subject</span>
              <div className="acp-email-subject-row">
                <span className="acp-email-subject-text">{suggestion.subject}</span>
                <CopyButton text={suggestion.subject} />
              </div>
            </div>
          )}
          {suggestion.body && (
            <div className="acp-email-body">
              <div className="acp-email-body-header">
                <span className="acp-field-label">Draft</span>
                <CopyButton text={`Subject: ${suggestion.subject || ''}\n\n${suggestion.body}`} />
              </div>
              <pre className="acp-email-pre">{suggestion.body}</pre>
            </div>
          )}
          {suggestion.keyPoints?.length > 0 && (
            <div className="acp-key-points">
              <span className="acp-field-label">Why this works</span>
              <ul>{suggestion.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </div>
          )}
          {suggestion.tone && (
            <div className="acp-tone-badge">Tone: <strong>{suggestion.tone}</strong></div>
          )}
        </div>
      )}

      {/* MEETING PREP */}
      {(type === 'meeting' || type === 'meeting_prep') && (
        <div className="acp-suggestion-meeting">
          {suggestion.agenda?.length > 0 && (
            <div className="acp-meeting-section">
              <span className="acp-field-label">📋 Agenda</span>
              <ol>{suggestion.agenda.map((a, i) => <li key={i}>{a}</li>)}</ol>
            </div>
          )}
          {suggestion.questions?.length > 0 && (
            <div className="acp-meeting-section">
              <span className="acp-field-label">❓ Questions to ask</span>
              <ul>{suggestion.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}
          {suggestion.sensitivities?.length > 0 && (
            <div className="acp-meeting-section acp-sensitivity">
              <span className="acp-field-label">⚠️ Handle carefully</span>
              <ul>{suggestion.sensitivities.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {suggestion.desiredOutcome && (
            <div className="acp-meeting-section acp-outcome">
              <span className="acp-field-label">🎯 Desired outcome</span>
              <p>{suggestion.desiredOutcome}</p>
            </div>
          )}
          {(suggestion.agenda || suggestion.questions) && (
            <CopyButton text={[
              suggestion.agenda?.length ? `AGENDA:\n${suggestion.agenda.map((a,i)=>`${i+1}. ${a}`).join('\n')}` : '',
              suggestion.questions?.length ? `\nKEY QUESTIONS:\n${suggestion.questions.map(q=>`• ${q}`).join('\n')}` : '',
              suggestion.desiredOutcome ? `\nGOAL: ${suggestion.desiredOutcome}` : '',
            ].filter(Boolean).join('\n')} />
          )}
        </div>
      )}

      {/* DOCUMENT PREP */}
      {type === 'document' && (
        <div className="acp-suggestion-document">
          {suggestion.documentType && (
            <div className="acp-doc-type">
              {suggestion.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </div>
          )}
          {suggestion.sections?.length > 0 && (
            <div className="acp-doc-sections">
              {suggestion.sections.map((s, i) => (
                <div key={i} className="acp-doc-section">
                  <div className="acp-doc-section-title">{s.title}</div>
                  <ul>{(s.points || []).map((p, j) => <li key={j}>{p}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
          {suggestion.keyMessages?.length > 0 && (
            <div className="acp-meeting-section">
              <span className="acp-field-label">Key messages</span>
              <ul>{suggestion.keyMessages.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
          )}
          {suggestion.toneAndAudience && (
            <div className="acp-tone-badge">{suggestion.toneAndAudience}</div>
          )}
        </div>
      )}

      {/* CALL / WHATSAPP / LINKEDIN */}
      {['call', 'whatsapp', 'linkedin', 'slack'].includes(type) && (
        <div className="acp-suggestion-message">
          {suggestion.opener && (
            <div className="acp-meeting-section">
              <span className="acp-field-label">How to open</span>
              <p>{suggestion.opener}</p>
            </div>
          )}
          {suggestion.messageDraft && (
            <div className="acp-email-body">
              <div className="acp-email-body-header">
                <span className="acp-field-label">{type === 'call' ? 'Talking points' : 'Message draft'}</span>
                <CopyButton text={suggestion.messageDraft} />
              </div>
              <pre className="acp-email-pre">{suggestion.messageDraft}</pre>
            </div>
          )}
          {suggestion.ask && (
            <div className="acp-meeting-section acp-outcome">
              <span className="acp-field-label">The ask</span>
              <p>{suggestion.ask}</p>
            </div>
          )}
          {suggestion.fallbackIfNoAnswer && (
            <div className="acp-meeting-section">
              <span className="acp-field-label">If no answer</span>
              <p>{suggestion.fallbackIfNoAnswer}</p>
            </div>
          )}
        </div>
      )}

      {/* GENERIC */}
      {type === 'generic' && (
        <div className="acp-suggestion-generic">
          {suggestion.guidance && <p>{suggestion.guidance}</p>}
          {suggestion.keyPoints?.length > 0 && (
            <ul>{suggestion.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
          )}
          {suggestion.nextStep && (
            <div className="acp-outcome">
              <span className="acp-field-label">Next step</span>
              <p>{suggestion.nextStep}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────
export default function ActionContextPanel({ action, onClose, onNavigate }) {
  const [suggestion,      setSuggestion]      = useState(null);
  const [aiLoading,       setAiLoading]       = useState(false);
  const [aiError,         setAiError]         = useState(null);
  const [contextInfo,     setContextInfo]     = useState(null);
  const [isMinimised,     setIsMinimised]     = useState(false);
  const panelRef = useRef(null);

  // Normalise action fields — backend returns camelCase from getAll but
  // snake_case from PATCH /status. Support both defensively throughout.
  const dealId    = action.deal?.id    || action.dealId    || action.deal_id    || null;
  const contactId = action.contact?.id || action.contactId || action.contact_id || null;
  const dealName  = action.deal?.name  || action.dealName  || null;
  const dealStage = action.deal?.stage || null;
  const dealValue = action.deal?.value || null;
  const dealAcct  = action.deal?.account || null;
  const actionType= action.actionType  || action.action_type || action.type || '';
  const nextStep  = action.nextStep    || action.next_step   || 'email';

  // Enrich the action object with normalised fields for resolveDestination + AI fetch
  const normAction = { ...action, actionType, nextStep, dealId, contactId };

  const destination = resolveDestination(normAction);
  const colors      = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;

  // ── Load AI suggestion on mount ────────────────────────────
  const loadSuggestion = async () => {
    setAiLoading(true);
    setAiError(null);
    setSuggestion(null);

    try {
      // Send normalised action so the backend always gets dealId regardless
      // of whether the original was camelCase or snake_case
      const result = await apiFetch('/ai/context-suggest', {
        method: 'POST',
        body:   JSON.stringify({ action: normAction }),
      });
      setSuggestion(result.suggestion);
      setContextInfo(result.context);
    } catch (err) {
      setAiError(err.message || 'Generation failed');
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    loadSuggestion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.id]);

  // ── Navigate + close ───────────────────────────────────────
  const handleGoThere = () => {
    onNavigate(destination.tab);
    // Dispatch custom event so Dashboard can pass context to the target view
    window.dispatchEvent(new CustomEvent('actionContext', {
      detail: { action: normAction, tab: destination.tab }
    }));
  };

  const dueDate = action.dueDate
    ? new Date(action.dueDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : null;

  const isOverdue = action.dueDate && new Date(action.dueDate) < new Date();

  return (
    <>
      {/* Backdrop (subtle) */}
      <div className="acp-backdrop" onClick={onClose} />

      {/* Panel */}
      <div
        className={`acp-panel ${isMinimised ? 'acp-panel--minimised' : ''}`}
        ref={panelRef}
      >
        {/* ── Panel header ───────────────────────────────────── */}
        <div className="acp-panel-header" style={{ borderTopColor: colors.border }}>
          <div className="acp-header-top">
            <div className="acp-header-left">
              <span className="acp-header-icon">
                {NEXT_STEP_ICONS[action.nextStep] || '🎯'}
              </span>
              <div className="acp-header-titles">
                <span className="acp-header-label">Action in progress</span>
                <h2 className="acp-header-title">{action.title}</h2>
              </div>
            </div>
            <div className="acp-header-actions">
              <button
                className="acp-icon-btn"
                onClick={() => setIsMinimised(m => !m)}
                title={isMinimised ? 'Expand' : 'Minimise'}
              >
                {isMinimised ? '▲' : '▼'}
              </button>
              <button className="acp-icon-btn acp-close-btn" onClick={onClose} title="Close panel">
                ×
              </button>
            </div>
          </div>

          {!isMinimised && (
            <div className="acp-header-meta">
              <span
                className="acp-priority-badge"
                style={{ background: colors.bg, color: colors.text, borderColor: colors.border }}
              >
                {action.priority}
              </span>
              {action.nextStep && (
                <span className="acp-nextstep-badge">
                  {NEXT_STEP_ICONS[action.nextStep]} {action.nextStep.replace(/_/g, ' ')}
                </span>
              )}
              {dueDate && (
                <span className={`acp-due-badge ${isOverdue ? 'overdue' : ''}`}>
                  {isOverdue ? '⚠️ ' : '📅 '}{dueDate}
                </span>
              )}
            </div>
          )}
        </div>

        {!isMinimised && (
          <div className="acp-panel-body">

            {/* ── Context section ─────────────────────────────── */}
            <div className="acp-context-section">
              {/* Deal info */}
              {(dealName || dealId) && (
                <div className="acp-context-deal">
                  <span className="acp-context-icon">💼</span>
                  <div>
                    <div className="acp-context-deal-name">
                      {dealName || `Deal #${dealId}`}
                    </div>
                    {(dealAcct || dealStage) && (
                      <div className="acp-context-deal-meta">
                        {[dealAcct, dealStage, dealValue ? `$${parseFloat(dealValue).toLocaleString()}` : null]
                          .filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Contact info */}
              {(action.contact || contactId) && (
                <div className="acp-context-contact">
                  <span className="acp-context-icon">👤</span>
                  <div>
                    <div className="acp-context-contact-name">
                      {action.contact?.firstName || action.contact?.first_name || `Contact #${contactId}`}
                      {' '}
                      {action.contact?.lastName  || action.contact?.last_name  || ''}
                    </div>
                    {action.contact?.email && (
                      <div className="acp-context-contact-meta">{action.contact.email}</div>
                    )}
                  </div>
                </div>
              )}

              {/* What needs to happen */}
              {(action.description || action.context) && (
                <div className="acp-what-section">
                  <span className="acp-field-label">What needs to happen</span>
                  <p className="acp-what-text">{action.description || action.context}</p>
                </div>
              )}

              {/* Suggested approach (from rule engine) */}
              {action.suggestedAction && (
                <div className="acp-suggested-section">
                  <span className="acp-field-label">Suggested approach</span>
                  <p className="acp-suggested-text">{action.suggestedAction}</p>
                </div>
              )}

              {/* Interaction history stats from AI context fetch */}
              {contextInfo && (
                <div className="acp-context-stats">
                  {contextInfo.emailCount > 0 && (
                    <span className="acp-stat">✉️ {contextInfo.emailCount} emails</span>
                  )}
                  {contextInfo.meetingCount > 0 && (
                    <span className="acp-stat">📅 {contextInfo.meetingCount} meetings</span>
                  )}
                  {contextInfo.hasTranscripts && (
                    <span className="acp-stat">🎙 Transcript available</span>
                  )}
                  {contextInfo.contactCount > 0 && (
                    <span className="acp-stat">👥 {contextInfo.contactCount} contacts</span>
                  )}
                </div>
              )}
            </div>

            {/* ── Navigate CTA ─────────────────────────────────── */}
            <div className="acp-navigate-section">
              <button className="acp-go-btn" onClick={handleGoThere}>
                <span className="acp-go-icon">{destination.icon}</span>
                <span className="acp-go-label">{destination.label}</span>
                <span className="acp-go-arrow">→</span>
              </button>
              <p className="acp-navigate-hint">
                This panel stays open while you work
              </p>
            </div>

            {/* ── AI Suggestion ─────────────────────────────────── */}
            <AISuggestion
              suggestion={suggestion}
              loading={aiLoading}
              error={aiError}
              onRegenerate={loadSuggestion}
            />

          </div>
        )}

        {/* Minimised state: just show the title + Go button */}
        {isMinimised && (
          <div className="acp-minimised-body">
            <span className="acp-minimised-title">{action.title}</span>
            <button className="acp-go-btn-mini" onClick={handleGoThere}>
              {destination.icon} Go →
            </button>
          </div>
        )}
      </div>
    </>
  );
}
