// ContractDetailPanel.js — v2 (Chunks 3 + 4)
// Changes from v1:
//   CHUNK 3 — Workflow & ownership
//   • STEPS stepper includes pending_booking
//   • STATUS_COLORS + STEP_LABELS cover all v2 statuses
//   • terminal set: void, expired, terminated, cancelled, amended
//   • Actions() per status fully wired:
//       draft      → submit / start-approval / delete / cancel
//       in_legal   → pick-up / reassign (legal) / recall (sales) / legal-send-sig
//       in_review/with_legal → pick up, return to sales, send to customer, send-sig
//       in_review/with_sales → resubmit, send-sig, send to customer
//       in_review/with_customer → route back to legal or sales
//       in_sig     → mark-signed / upload-executed inline / recall / cancel
//       pending_bk → confirm-booking / cancel
//       signed     → activate
//       active     → amend / terminate
//       expired    → terminate
//       void|term|cancelled|amended → no actions
//   • Reassign legal inline form (legal-only)
//   • Terminate/Cancel inline confirm forms
//   CHUNK 4 — Signatures overhaul
//   • "Upload Executed Document" inline form on in_signatures status
//   • "Mark Customer-Initiated Signing" button + flag display
//   • pending_booking → Confirm Booking
//   • DetailsTab shows all v2 metadata fields (read + edit)
//   • Edit form available to legal members on in_review
//   • Header shows standalone badge when no deal linked
//   • EV_ICONS expanded for all v2 event types

import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import DocumentVersionsPanel from './DocumentVersionsPanel';
import LegalReviewPanel from './LegalReviewPanel';
import './ContractDetailPanel.css';

// ── Constants ────────────────────────────────────────────────────────────────

const STEPS = [
  'draft', 'in_review',
  'in_signatures', 'pending_booking', 'signed', 'active',
];
const STEP_LABELS = {
  draft: 'Draft', in_review: 'In Review',
  in_signatures: 'Signatures', pending_booking: 'Booking', signed: 'Signed', active: 'Active',
};

// Statuses that sit off the main track (terminal or branch)
const TERMINAL_STATUSES = new Set(['void', 'expired', 'terminated', 'cancelled', 'amended']);

const STATUS_COLORS = {
  draft:           { bg: '#f1f5f9', text: '#475569' },
  in_review:       { bg: '#fef3c7', text: '#92400e' },
  in_signatures:   { bg: '#ede9fe', text: '#5b21b6' },
  pending_booking: { bg: '#fce7f3', text: '#9d174d' },
  signed:          { bg: '#dcfce7', text: '#14532d' },
  active:          { bg: '#d1fae5', text: '#065f46' },
  expired:         { bg: '#f3f4f6', text: '#6b7280' },
  amended:         { bg: '#fef9c3', text: '#713f12' },
  terminated:      { bg: '#fee2e2', text: '#7f1d1d' },
  cancelled:       { bg: '#f3f4f6', text: '#374151' },
  void:            { bg: '#fee2e2', text: '#991b1b' },
};

const TERMINAL_LABELS = {
  void:       '🚫 Void',
  expired:    '⌛ Expired',
  terminated: '🔴 Terminated',
  cancelled:  '✕ Cancelled',
  amended:    '📝 Amended',
};

const TYPE_LABELS = {
  nda: 'NDA', msa: 'MSA', sow: 'SOW',
  order_form: 'Order Form', amendment: 'Amendment', custom: 'Custom',
};

const COMPANY_ENTITY_LABELS = { us: '🇺🇸 US', uk: '🇬🇧 UK', de: '🇩🇪 DE' };

const AMENDMENT_SUBTYPE_LABELS = {
  expansion: 'Expansion', reduction: 'Reduction',
  scope: 'Scope change', other: 'Other',
};

const APPR_COLORS = {
  not_started: { bg: '#f1f5f9', text: '#94a3b8', label: 'Not started' },
  pending:     { bg: '#fef3c7', text: '#92400e', label: 'Pending' },
  approved:    { bg: '#d1fae5', text: '#065f46', label: 'Approved' },
  rejected:    { bg: '#fee2e2', text: '#991b1b', label: 'Rejected' },
};

const EV_ICONS = {
  draft_created:                      '✏️',
  submitted_for_legal_review:         '📤',
  legal_picked_up:                    '👋',
  legal_reassigned:                   '↔️',
  returned_to_sales:                  '📥',
  document_version_uploaded:          '📎',
  resubmitted_to_legal:               '🔄',
  internal_approval_started:          '🔐',
  internal_approval_step_approved:    '✅',
  internal_approval_rejected:         '❌',
  internal_fully_approved:            '🎉',
  internal_approval_auto_approved:    '⚡',
  sent_for_signature:                 '✍️',
  legal_sent_for_signature:           '⚖️',
  customer_signing_initiated:         '🤝',
  signed_by_external:                 '📝',
  executed_document_uploaded:         '📜',
  activated:                          '🚀',
  pending_booking:                    '📅',
  booking_confirmed:                  '✅',
  expired:                            '⌛',
  voided:                             '🚫',
  terminated:                         '🔴',
  cancelled:                          '✕',
  recalled:                           '↩️',
  amendment_created:                  '📄',
  amendment_spawned:                  '🌿',
  amended:                            '📝',
  note_added:                         '💬',
};

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'INR'];

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Small reusable components ─────────────────────────────────────────────────

function ActionBtn({ label, variant = 'secondary', onClick, disabled, loading }) {
  return (
    <button className={`cdp-btn cdp-btn--${variant}`}
      onClick={onClick} disabled={disabled || loading}>
      {loading ? '…' : label}
    </button>
  );
}

function ConfirmInline({ placeholder, onConfirm, onCancel, confirmLabel = 'Confirm', danger, children }) {
  const [val, setVal] = useState('');
  return (
    <div className="cdp-inline-confirm">
      {children}
      {placeholder && (
        <input className="cdp-inline-input" placeholder={placeholder}
          value={val} onChange={e => setVal(e.target.value)} />
      )}
      <div className="cdp-inline-btns">
        <button className={`cdp-inline-ok ${danger ? 'cdp-inline-ok--danger' : ''}`}
          onClick={() => onConfirm(val)}>{confirmLabel}</button>
        <button className="cdp-inline-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Inline form for uploading an executed document (Chunk 4)
function ExecutedUploadInline({ contractId, onDone, onCancel }) {
  const [url, setUrl]         = useState('');
  const [provider, setProvider] = useState('google_drive');
  const [comment, setComment] = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');

  async function submit() {
    if (!url.trim()) { setErr('Document URL is required'); return; }
    setBusy(true); setErr('');
    try {
      await apiService.contracts.uploadExecutedDocument(contractId, {
        documentUrl: url, documentProvider: provider,
        versionComment: comment || 'Executed document uploaded',
      });
      onDone();
    } catch (e) {
      setErr(e.response?.data?.error?.message || e.message || 'Upload failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="cdp-inline-confirm">
      <div className="cdp-inline-title">📜 Upload Executed Document</div>
      {err && <div className="cdp-inline-err">{err}</div>}
      <input className="cdp-inline-input"
        placeholder="Executed document URL (Google Drive / OneDrive)"
        value={url} onChange={e => setUrl(e.target.value)} />
      <select className="cdp-inline-input" value={provider}
        onChange={e => setProvider(e.target.value)}>
        <option value="google_drive">🔵 Google Drive</option>
        <option value="onedrive">🟦 OneDrive</option>
        <option value="other">🔗 Other</option>
      </select>
      <input className="cdp-inline-input"
        placeholder="Comment (optional)"
        value={comment} onChange={e => setComment(e.target.value)} />
      <div className="cdp-inline-note">
        This will mark the contract as executed and move it to Pending Booking.
      </div>
      <div className="cdp-inline-btns">
        <button className="cdp-inline-ok" onClick={submit} disabled={busy}>
          {busy ? 'Uploading…' : 'Upload & Mark Executed'}
        </button>
        <button className="cdp-inline-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Inline form for reassigning to a legal team member
function ReassignInline({ contractId, legalMembers, onDone, onCancel }) {
  const [assigneeId, setAssigneeId] = useState('');
  const [busy, setBusy]             = useState(false);

  async function submit() {
    if (!assigneeId) return;
    setBusy(true);
    try {
      await apiService.contracts.reassign(contractId, parseInt(assigneeId, 10));
      onDone();
    } catch (e) { alert(e.response?.data?.error?.message || 'Reassign failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="cdp-inline-confirm">
      <div className="cdp-inline-title">Reassign to Legal Team Member</div>
      <select className="cdp-inline-input" value={assigneeId}
        onChange={e => setAssigneeId(e.target.value)}>
        <option value="">Select…</option>
        {legalMembers.map(m => (
          <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>
        ))}
      </select>
      <div className="cdp-inline-btns">
        <button className="cdp-inline-ok" onClick={submit}
          disabled={!assigneeId || busy}>{busy ? '…' : 'Reassign'}</button>
        <button className="cdp-inline-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ContractDetailPanel({ contract: c, isLegalMember, onClose, onUpdated }) {
  const [tab, setTab]                       = useState('details');
  const [busy, setBusy]                     = useState('');
  const [err, setErr]                       = useState('');

  // Inline form toggles
  const [showVoid, setShowVoid]             = useState(false);
  const [showRecall, setShowRecall]         = useState(false);
  const [showTerminate, setShowTerminate]   = useState(false);
  const [showCancel, setShowCancel]         = useState(false);
  const [showReassign, setShowReassign]     = useState(false);
  const [showExecUpload, setShowExecUpload] = useState(false);

  const [legalMembers, setLegalMembers]     = useState([]);

  useEffect(() => {
    if (isLegalMember) {
      apiService.contracts.getLegalMembers()
        .then(r => setLegalMembers(r.data?.members || []))
        .catch(() => {});
    }
  }, [isLegalMember]);

  const sc      = STATUS_COLORS[c.status] || STATUS_COLORS.draft;
  const sidx    = STEPS.indexOf(c.status);
  const ac      = APPR_COLORS[c.internalApprovalStatus] || APPR_COLORS.not_started;
  const isTerminal = TERMINAL_STATUSES.has(c.status);

  function closeAllForms() {
    setShowVoid(false); setShowRecall(false); setShowTerminate(false);
    setShowCancel(false); setShowReassign(false); setShowExecUpload(false);
  }

  async function act(key, fn) {
    setBusy(key); setErr(''); closeAllForms();
    try { await fn(); onUpdated(); }
    catch (e) { setErr(e.response?.data?.error?.message || e.message || 'Action failed'); }
    finally { setBusy(''); }
  }

  // ── Actions panel ──────────────────────────────────────────────────────────
  function Actions() {
    const id = c.id;

    return (
      <div className="cdp-actions">
        {err && <div className="cdp-err">{err}</div>}

        {/* ── DRAFT ── */}
        {c.status === 'draft' && <>
          <ActionBtn label="Submit for Legal Review" variant="primary"
            loading={busy === 'submit'}
            onClick={() => act('submit', () => apiService.contracts.submitForLegal(id, {}))} />
          {c.internalApprovalStatus === 'not_started' && (
            <ActionBtn label="Start Internal Approval" variant="secondary"
              loading={busy === 'approval'}
              onClick={() => act('approval', () => apiService.contracts.startApproval(id))} />
          )}
          <ActionBtn label="Cancel" variant="warning"
            onClick={() => setShowCancel(true)} />
          <ActionBtn label="Delete" variant="danger"
            loading={busy === 'del'}
            onClick={() => act('del', async () => { await apiService.contracts.delete(id); onClose(); })} />
        </>}

        {/* ── IN REVIEW ── */}
        {c.status === 'in_review' && <>
          {/* Sub-stage indicator strip */}
          <div className="cdp-review-substage-bar">
            {['with_legal','with_sales','with_customer'].map(sub => (
              <span key={sub}
                className={`cdp-substage-pill${c.reviewSubStatus === sub ? ' cdp-substage-pill--active' : ''}`}>
                { sub === 'with_legal' ? '⚖️ Legal'
                  : sub === 'with_sales' ? '💼 Sales'
                  : '🤝 Customer' }
              </span>
            ))}
          </div>

          {/* with_legal: legal member actions */}
          {c.reviewSubStatus === 'with_legal' && isLegalMember && <>
            {c.legalQueue && (
              <ActionBtn label="Pick Up" variant="primary"
                loading={busy === 'pickup'}
                onClick={() => act('pickup', () => apiService.contracts.pickUp(id))} />
            )}
            <ActionBtn label="Return to Sales" variant="secondary"
              loading={busy === 'return'}
              onClick={() => act('return', () => apiService.contracts.handoffTo(id, 'with_sales'))} />
            <ActionBtn label="Send to Customer for Review" variant="secondary"
              loading={busy === 'tocustomer'}
              onClick={() => act('tocustomer', () => apiService.contracts.handoffTo(id, 'with_customer'))} />
            <ActionBtn label="Send for Signature" variant="secondary"
              loading={busy === 'legalsend'}
              onClick={() => act('legalsend', () => apiService.contracts.legalSendSignature(id))} />
            <ActionBtn label="Reassign" variant="secondary"
              onClick={() => setShowReassign(r => !r)} />
            <ActionBtn label="Cancel Contract" variant="warning"
              onClick={() => setShowCancel(true)} />
          </>}

          {/* with_legal: sales member actions (recall only) */}
          {c.reviewSubStatus === 'with_legal' && !isLegalMember && <>
            <ActionBtn label="Recall to Draft" variant="warning"
              onClick={() => setShowRecall(true)} />
            <ActionBtn label="Cancel Contract" variant="warning"
              onClick={() => setShowCancel(true)} />
          </>}

          {/* with_sales: sales actions */}
          {c.reviewSubStatus === 'with_sales' && <>
            <ActionBtn label="Resubmit to Legal" variant="primary"
              loading={busy === 'resubmit'}
              onClick={() => act('resubmit', () => apiService.contracts.handoffTo(id, 'with_legal'))} />
            <ActionBtn label="Send to Customer for Review" variant="secondary"
              loading={busy === 'tocustomer'}
              onClick={() => act('tocustomer', () => apiService.contracts.handoffTo(id, 'with_customer'))} />
            <ActionBtn
              label={c.internalApprovalStatus !== 'approved' ? 'Send for Signature ⚠️' : 'Send for Signature'}
              variant={c.internalApprovalStatus === 'approved' ? 'primary' : 'warning'}
              loading={busy === 'send'}
              onClick={() => act('send', () => apiService.contracts.sendForSignature(id))} />
            {c.internalApprovalStatus === 'not_started' && (
              <ActionBtn label="Start Internal Approval" variant="secondary"
                loading={busy === 'approval'}
                onClick={() => act('approval', () => apiService.contracts.startApproval(id))} />
            )}
            {isLegalMember && (
              <ActionBtn label="Legal: Send for Signature" variant="secondary"
                loading={busy === 'legalsend'}
                onClick={() => act('legalsend', () => apiService.contracts.legalSendSignature(id))} />
            )}
            <ActionBtn label="Cancel Contract" variant="warning"
              onClick={() => setShowCancel(true)} />
          </>}

          {/* with_customer: any team member can route next step */}
          {c.reviewSubStatus === 'with_customer' && <>
            <div className="cdp-substage-note">
              📄 Draft sent to customer for review. Redlines may come back multiple times.
            </div>
            <ActionBtn label="Customer Returned Redlines → Legal" variant="primary"
              loading={busy === 'custback'}
              onClick={() => act('custback', () => apiService.contracts.handoffTo(id, 'with_legal'))} />
            <ActionBtn label="Route Back to Sales" variant="secondary"
              loading={busy === 'custtosales'}
              onClick={() => act('custtosales', () => apiService.contracts.handoffTo(id, 'with_sales'))} />
            {isLegalMember && (
              <ActionBtn label="Send for Signature" variant="secondary"
                loading={busy === 'legalsend'}
                onClick={() => act('legalsend', () => apiService.contracts.legalSendSignature(id))} />
            )}
            <ActionBtn label="Send for Signature" variant="secondary"
              loading={busy === 'send'}
              onClick={() => act('send', () => apiService.contracts.sendForSignature(id))} />
            <ActionBtn label="Cancel Contract" variant="warning"
              onClick={() => setShowCancel(true)} />
          </>}
        </>}

        {/* ── IN SIGNATURES ── */}
        {c.status === 'in_signatures' && <>
          <ActionBtn label="Mark as Signed" variant="primary"
            loading={busy === 'signed'}
            onClick={() => act('signed', () => apiService.contracts.markSigned(id))} />
          <ActionBtn label="Upload Executed Doc" variant="secondary"
            onClick={() => setShowExecUpload(s => !s)} />
          {!c.customerInitiatedSigning && (
            <ActionBtn label="Mark Customer Signing" variant="secondary"
              loading={busy === 'custsign'}
              onClick={() => act('custsign', () =>
                apiService.contracts.markCustomerSigning(id, { customerInitiatedSigning: true })
              )} />
          )}
          {c.customerInitiatedSigning && (
            <span className="cdp-flag-badge">🤝 Customer-initiated signing</span>
          )}
          <ActionBtn label="Recall" variant="warning"
            onClick={() => setShowRecall(true)} />
          <ActionBtn label="Cancel Contract" variant="warning"
            onClick={() => setShowCancel(true)} />
        </>}

        {/* ── PENDING BOOKING ── */}
        {c.status === 'pending_booking' && <>
          <ActionBtn label="Confirm Booking" variant="primary"
            loading={busy === 'book'}
            onClick={() => act('book', () => apiService.contracts.confirmBooking(id))} />
          <ActionBtn label="Cancel Contract" variant="warning"
            onClick={() => setShowCancel(true)} />
        </>}

        {/* ── SIGNED ── */}
        {c.status === 'signed' && (
          <ActionBtn label="Activate" variant="primary"
            loading={busy === 'activate'}
            onClick={() => act('activate', () => apiService.contracts.activate(id))} />
        )}

        {/* ── ACTIVE ── */}
        {c.status === 'active' && <>
          <ActionBtn label="Amend" variant="secondary"
            loading={busy === 'amend'}
            onClick={() => act('amend', () => apiService.contracts.amend(id))} />
          <ActionBtn label="Terminate" variant="danger"
            onClick={() => setShowTerminate(true)} />
        </>}

        {/* ── EXPIRED ── */}
        {c.status === 'expired' && (
          <ActionBtn label="Terminate" variant="danger"
            onClick={() => setShowTerminate(true)} />
        )}

        {/* ── Void available for all non-terminal pre-active statuses ── */}
        {!isTerminal && !['active', 'expired'].includes(c.status) && (
          <ActionBtn label="Void" variant="danger"
            onClick={() => setShowVoid(true)} />
        )}

        {/* ── Inline forms ── */}
        {showExecUpload && (
          <ExecutedUploadInline
            contractId={id}
            onDone={() => { setShowExecUpload(false); onUpdated(); }}
            onCancel={() => setShowExecUpload(false)}
          />
        )}

        {showReassign && (
          <ReassignInline
            contractId={id}
            legalMembers={legalMembers}
            onDone={() => { setShowReassign(false); onUpdated(); }}
            onCancel={() => setShowReassign(false)}
          />
        )}

        {showVoid && (
          <ConfirmInline
            placeholder="Reason for voiding (optional)"
            confirmLabel="Confirm Void" danger
            onConfirm={reason => act('void', () => apiService.contracts.void(id, { reason }))}
            onCancel={() => setShowVoid(false)} />
        )}

        {showRecall && (
          <ConfirmInline
            placeholder="Reason for recall (optional)"
            confirmLabel="Confirm Recall"
            onConfirm={reason => act('recall', () => apiService.contracts.recall(id, { reason }))}
            onCancel={() => setShowRecall(false)} />
        )}

        {showTerminate && (
          <ConfirmInline
            placeholder="Reason for termination (optional)"
            confirmLabel="Confirm Termination" danger
            onConfirm={reason => act('terminate', () => apiService.contracts.terminate(id, { reason }))}
            onCancel={() => setShowTerminate(false)} />
        )}

        {showCancel && (
          <ConfirmInline
            placeholder="Reason for cancellation (optional)"
            confirmLabel="Confirm Cancellation" danger
            onConfirm={reason => act('cancel', () => apiService.contracts.cancel(id, { reason }))}
            onCancel={() => setShowCancel(false)} />
        )}
      </div>
    );
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  const TABS = [
    { id: 'details',      label: 'Details' },
    { id: 'document',     label: 'Document' },
    { id: 'legal',        label: 'Legal' },
    { id: 'approvals',    label: 'Approvals' },
    { id: 'signatories',  label: 'Signatories' },
    { id: 'timeline',     label: 'Timeline' },
  ];

  return (
    <div className="cdp-wrap">
      {/* ── Header ── */}
      <div className="cdp-header">
        <div className="cdp-header-row">
          <div className="cdp-badges">
            <span className="cdp-type-badge">{TYPE_LABELS[c.contractType] || c.contractType}</span>
            <span className="cdp-status-badge" style={{ background: sc.bg, color: sc.text }}>
              {STEP_LABELS[c.status] || c.status}
            </span>
            {!c.dealName && <span className="cdp-standalone-badge">🔖 Standalone</span>}
          </div>
          <button className="cdp-close" onClick={onClose}>✕</button>
        </div>
        <h2 className="cdp-title">{c.title}</h2>
        <div className="cdp-subtitle">
          {c.customerLegalName && <span>{c.customerLegalName}</span>}
          {c.companyEntity && (
            <span> · {COMPANY_ENTITY_LABELS[c.companyEntity] || c.companyEntity}</span>
          )}
          {c.value != null && (
            <span> · {c.currency} {Number(c.value).toLocaleString()}</span>
          )}
          {c.dealName
            ? <span> · 📂 {c.dealName}</span>
            : <span> · No linked deal</span>
          }
          {c.legalAssigneeName && (
            <span> · ⚖️ {c.legalAssigneeName}</span>
          )}
        </div>
      </div>

      {/* ── Workflow stepper ── */}
      <div className="cdp-stepper">
        {STEPS.map((s, i) => {
          const active = s === c.status;
          const done   = sidx > i && !isTerminal;
          return (
            <React.Fragment key={s}>
              {i > 0 && <div className={`cdp-line ${(done || active) ? 'cdp-line--on' : ''}`} />}
              <div className={`cdp-step ${active ? 'cdp-step--cur' : ''} ${done ? 'cdp-step--done' : ''}`}>
                <div className="cdp-dot">{done ? '✓' : i + 1}</div>
                <div className="cdp-step-lbl">{STEP_LABELS[s]}</div>
              </div>
            </React.Fragment>
          );
        })}
        {isTerminal && (
          <div className="cdp-terminal" style={{ background: sc.bg, color: sc.text }}>
            {TERMINAL_LABELS[c.status] || c.status}
          </div>
        )}
      </div>

      {/* ── Internal approval bar ── */}
      <div className="cdp-appr-bar">
        <span className="cdp-appr-lbl">Internal Approval:</span>
        <span className="cdp-appr-pill" style={{ background: ac.bg, color: ac.text }}>
          {ac.label}
        </span>
        {c.internalApprovalStatus === 'not_started' && !isTerminal && (
          <button className="cdp-appr-start"
            onClick={() => act('approval', () => apiService.contracts.startApproval(c.id))}>
            Start
          </button>
        )}
      </div>

      <Actions />

      {/* ── Inner tabs ── */}
      <div className="cdp-tabs">
        {TABS.map(t => (
          <button key={t.id}
            className={`cdp-tab ${tab === t.id ? 'cdp-tab--on' : ''}`}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="cdp-body">
        {tab === 'details'     && <DetailsTab c={c} isLegalMember={isLegalMember} onUpdated={onUpdated} />}
        {tab === 'document'    && <DocumentVersionsPanel contract={c} onUpdated={onUpdated} />}
        {tab === 'legal'       && <LegalReviewPanel contract={c} isLegalMember={isLegalMember} onUpdated={onUpdated} />}
        {tab === 'approvals'   && <ApprovalsTab c={c} onUpdated={onUpdated} />}
        {tab === 'signatories' && <SignatoriesTab c={c} onUpdated={onUpdated} />}
        {tab === 'timeline'    && <TimelineTab events={c.events || []} />}
      </div>
    </div>
  );
}

// ── Details tab ───────────────────────────────────────────────────────────────
// Edit allowed for: draft (anyone), in_review (legal members)

function DetailsTab({ c, isLegalMember, onUpdated }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState({});
  const [saving, setSaving]   = useState(false);

  const canEdit = c.status === 'draft'
    || (isLegalMember && c.status === 'in_review');

  function startEdit() {
    setForm({
      title:                     c.title || '',
      value:                     c.value || '',
      currency:                  c.currency || 'USD',
      customerLegalName:         c.customerLegalName || '',
      companyEntity:             c.companyEntity || '',
      includeFullDpa:            c.includeFullDpa || false,
      terminationForConvenience: c.terminationForConvenience || false,
      tfcStartDate:              c.tfcStartDate?.split('T')[0] || '',
      tfcEndDate:                c.tfcEndDate?.split('T')[0] || '',
      specialTerms:              c.specialTerms || '',
      agreementEndDate:          c.agreementEndDate?.split('T')[0] || '',
      effectiveDate:             c.effectiveDate?.split('T')[0] || '',
      expiryDate:                c.expiryDate?.split('T')[0] || '',
      arrImpact:                 c.arrImpact || false,
      amendmentSubtype:          c.amendmentSubtype || '',
    });
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      await apiService.contracts.update(c.id, form);
      setEditing(false); onUpdated();
    } catch (e) {
      alert(e.response?.data?.error?.message || 'Save failed');
    } finally { setSaving(false); }
  }

  function f(k, v) { setForm(prev => ({ ...prev, [k]: v })); }

  if (editing) return (
    <div className="cdp-edit">
      <label className="cdp-lbl">Title
        <input className="cdp-inp" value={form.title}
          onChange={e => f('title', e.target.value)} />
      </label>

      <div className="cdp-row2">
        <label className="cdp-lbl">Value
          <input className="cdp-inp" type="number" value={form.value}
            onChange={e => f('value', e.target.value)} />
        </label>
        <label className="cdp-lbl">Currency
          <select className="cdp-inp" value={form.currency}
            onChange={e => f('currency', e.target.value)}>
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <label className="cdp-lbl">Customer Legal Name
        <input className="cdp-inp" value={form.customerLegalName}
          onChange={e => f('customerLegalName', e.target.value)} />
      </label>

      <label className="cdp-lbl">Company Entity
        <select className="cdp-inp" value={form.companyEntity}
          onChange={e => f('companyEntity', e.target.value)}>
          <option value="">—</option>
          <option value="us">🇺🇸 US</option>
          <option value="uk">🇬🇧 UK</option>
          <option value="de">🇩🇪 DE</option>
        </select>
      </label>

      <div className="cdp-check-group">
        <label className="cdp-check">
          <input type="checkbox" checked={form.includeFullDpa}
            onChange={e => f('includeFullDpa', e.target.checked)} />
          Include full DPA
        </label>
        <label className="cdp-check">
          <input type="checkbox" checked={form.terminationForConvenience}
            onChange={e => f('terminationForConvenience', e.target.checked)} />
          Termination for convenience
        </label>
      </div>

      {form.terminationForConvenience && (
        <div className="cdp-row2">
          <label className="cdp-lbl">TFC Start
            <input className="cdp-inp" type="date" value={form.tfcStartDate}
              onChange={e => f('tfcStartDate', e.target.value)} />
          </label>
          <label className="cdp-lbl">TFC End
            <input className="cdp-inp" type="date" value={form.tfcEndDate}
              onChange={e => f('tfcEndDate', e.target.value)} />
          </label>
        </div>
      )}

      <label className="cdp-lbl">Special Terms
        <textarea className="cdp-inp cdp-textarea" rows={2} value={form.specialTerms}
          onChange={e => f('specialTerms', e.target.value)} />
      </label>

      <div className="cdp-row2">
        <label className="cdp-lbl">Effective Date
          <input className="cdp-inp" type="date" value={form.effectiveDate}
            onChange={e => f('effectiveDate', e.target.value)} />
        </label>
        <label className="cdp-lbl">Expiry Date
          <input className="cdp-inp" type="date" value={form.expiryDate}
            onChange={e => f('expiryDate', e.target.value)} />
        </label>
      </div>

      <label className="cdp-lbl">Agreement End Date
        <input className="cdp-inp" type="date" value={form.agreementEndDate}
          onChange={e => f('agreementEndDate', e.target.value)} />
      </label>

      {c.contractType === 'amendment' && <>
        <label className="cdp-check">
          <input type="checkbox" checked={form.arrImpact}
            onChange={e => f('arrImpact', e.target.checked)} />
          This amendment changes ARR
        </label>
        <label className="cdp-lbl">Amendment Type
          <select className="cdp-inp" value={form.amendmentSubtype}
            onChange={e => f('amendmentSubtype', e.target.value)}>
            <option value="">—</option>
            <option value="expansion">Expansion</option>
            <option value="reduction">Reduction</option>
            <option value="scope">Scope change</option>
            <option value="other">Other</option>
          </select>
        </label>
      </>}

      <div className="cdp-edit-btns">
        <button className="cdp-save" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="cdp-cancel" onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  );

  // ── Read view ──
  return (
    <div>
      <div className="cdp-section-hd">
        <span className="cdp-section-ttl">Contract Details</span>
        {canEdit && (
          <button className="cdp-edit-btn" onClick={startEdit}>Edit</button>
        )}
      </div>

      <div className="cdp-grid">
        <div className="cdp-field">
          <div className="cdp-fk">Owner</div>
          <div className="cdp-fv">{c.ownerName || '—'}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">Type</div>
          <div className="cdp-fv">{TYPE_LABELS[c.contractType] || c.contractType}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">Customer Legal Name</div>
          <div className="cdp-fv">{c.customerLegalName || '—'}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">Company Entity</div>
          <div className="cdp-fv">
            {c.companyEntity ? (COMPANY_ENTITY_LABELS[c.companyEntity] || c.companyEntity) : '—'}
          </div>
        </div>
        {c.value != null && (
          <div className="cdp-field">
            <div className="cdp-fk">Value</div>
            <div className="cdp-fv">{c.currency} {Number(c.value).toLocaleString()}</div>
          </div>
        )}
        <div className="cdp-field">
          <div className="cdp-fk">Effective Date</div>
          <div className="cdp-fv">{fmt(c.effectiveDate)}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">Expiry / End Date</div>
          <div className="cdp-fv">{fmt(c.agreementEndDate || c.expiryDate)}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">Legal Assignee</div>
          <div className="cdp-fv">{c.legalAssigneeName || (c.legalQueue ? 'In queue' : '—')}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">DPA</div>
          <div className="cdp-fv">{c.includeFullDpa ? '✓ Full DPA included' : 'Standard'}</div>
        </div>
        <div className="cdp-field">
          <div className="cdp-fk">Termination for Convenience</div>
          <div className="cdp-fv">
            {c.terminationForConvenience
              ? `Yes${c.tfcStartDate ? ` · ${fmt(c.tfcStartDate)} → ${fmt(c.tfcEndDate)}` : ''}`
              : 'No'}
          </div>
        </div>
        {c.contractType === 'amendment' && <>
          <div className="cdp-field">
            <div className="cdp-fk">ARR Impact</div>
            <div className="cdp-fv">{c.arrImpact ? 'Yes' : 'No'}</div>
          </div>
          {c.amendmentSubtype && (
            <div className="cdp-field">
              <div className="cdp-fk">Amendment Type</div>
              <div className="cdp-fv">
                {AMENDMENT_SUBTYPE_LABELS[c.amendmentSubtype] || c.amendmentSubtype}
              </div>
            </div>
          )}
        </>}
        {c.customerInitiatedSigning && (
          <div className="cdp-field" style={{ gridColumn: '1/-1' }}>
            <div className="cdp-fk">Signing</div>
            <div className="cdp-fv">🤝 Customer-initiated signing</div>
          </div>
        )}
        {c.specialTerms && (
          <div className="cdp-field" style={{ gridColumn: '1/-1' }}>
            <div className="cdp-fk">Special Terms</div>
            <div className="cdp-fv cdp-fv--pre">{c.specialTerms}</div>
          </div>
        )}
        <div className="cdp-field">
          <div className="cdp-fk">Created</div>
          <div className="cdp-fv">{fmt(c.createdAt)}</div>
        </div>
        {c.dealName && (
          <div className="cdp-field">
            <div className="cdp-fk">Linked Deal</div>
            <div className="cdp-fv">📂 {c.dealName}</div>
          </div>
        )}
      </div>

      {/* Hierarchy */}
      {(c.parentContractId || c.children?.length > 0) && (
        <div className="cdp-hierarchy">
          <div className="cdp-section-ttl" style={{ marginBottom: 6 }}>Hierarchy</div>
          {c.parentContractId && (
            <div className="cdp-hier-up">
              ↑ Parent: {c.parentTitle} <span className="cdp-hier-type">({c.parentType})</span>
              {c.parentStatus && (
                <span className="cdp-hier-status"> · {c.parentStatus}</span>
              )}
            </div>
          )}
          {c.children?.map(ch => (
            <div key={ch.id} className="cdp-hier-dn">
              └─ {ch.title}
              <span className="cdp-hier-type"> ({ch.contract_type})</span>
              <span className="cdp-hier-status"> · {ch.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Approvals tab ─────────────────────────────────────────────────────────────

function ApprovalsTab({ c, onUpdated }) {
  const [deciding, setDeciding] = useState(null);
  const [note, setNote]         = useState('');
  const [busy, setBusy]         = useState('');

  async function decide(approvalId, decision) {
    setBusy(approvalId + decision);
    try {
      await apiService.contracts.decideApproval(approvalId, decision, note);
      setDeciding(null); setNote(''); onUpdated();
    } catch (e) { alert(e.response?.data?.error?.message || 'Failed'); }
    finally { setBusy(''); }
  }

  const approvals = c.approvals || [];
  if (!approvals.length) return (
    <div className="cdp-empty-tab">
      No approval chain configured.
      {!TERMINAL_STATUSES.has(c.status) && (
        <button className="cdp-tab-btn"
          onClick={() =>
            apiService.contracts.startApproval(c.id)
              .then(onUpdated)
              .catch(e => alert(e.message))
          }>
          Start Approval Chain
        </button>
      )}
    </div>
  );

  return (
    <div className="cdp-approvals">
      {approvals.map(a => (
        <div key={a.id} className={`cdp-appr-row cdp-appr-row--${a.status}`}>
          <div className="cdp-appr-step">Step {a.step_order}</div>
          <div className="cdp-appr-info">
            <div className="cdp-appr-name">{a.first_name} {a.last_name}</div>
            <div className="cdp-appr-role">{a.approver_role}</div>
            {a.decision_note && <div className="cdp-appr-note">"{a.decision_note}"</div>}
          </div>
          <div className="cdp-appr-right">
            <span className={`cdp-appr-status cdp-appr-status--${a.status}`}>{a.status}</span>
            {a.decided_at && <div className="cdp-appr-date">{fmt(a.decided_at)}</div>}
          </div>
          {a.status === 'pending' && deciding !== a.id && (
            <button className="cdp-decide-btn" onClick={() => setDeciding(a.id)}>Decide</button>
          )}
          {deciding === a.id && (
            <div className="cdp-decide-form">
              <input className="cdp-inline-input" placeholder="Note (optional)"
                value={note} onChange={e => setNote(e.target.value)} />
              <div className="cdp-inline-btns">
                <button className="cdp-inline-ok"
                  onClick={() => decide(a.id, 'approved')} disabled={!!busy}>Approve</button>
                <button className="cdp-inline-ok cdp-inline-ok--danger"
                  onClick={() => decide(a.id, 'rejected')} disabled={!!busy}>Reject</button>
                <button className="cdp-inline-cancel"
                  onClick={() => setDeciding(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Signatories tab ───────────────────────────────────────────────────────────

function SignatoriesTab({ c, onUpdated }) {
  const [form, setForm]   = useState({ name: '', email: '', signatoryType: 'external', role: 'signer' });
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  async function add() {
    setSaving(true);
    try {
      await apiService.contracts.addSignatory(c.id, form);
      setAdding(false);
      setForm({ name: '', email: '', signatoryType: 'external', role: 'signer' });
      onUpdated();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  }

  async function remove(sid) {
    if (!window.confirm('Remove signatory?')) return;
    try { await apiService.contracts.removeSignatory(c.id, sid); onUpdated(); }
    catch (e) { alert(e.message); }
  }

  return (
    <div className="cdp-sigs">
      {c.customerInitiatedSigning && (
        <div className="cdp-sig-notice">
          🤝 Customer-initiated signing — customer will sign first.
        </div>
      )}
      {(c.signatories || []).map(s => (
        <div key={s.id} className="cdp-sig">
          <div>
            <div className="cdp-sig-name">{s.name}</div>
            <div className="cdp-sig-email">{s.email}</div>
            <div className="cdp-sig-meta">
              <span className="cdp-sig-chip">{s.role}</span>
              <span className="cdp-sig-chip">{s.signatory_type}</span>
              {s.signed_at && <span className="cdp-sig-signed">✓ {fmt(s.signed_at)}</span>}
            </div>
          </div>
          <button className="cdp-rm-btn" onClick={() => remove(s.id)}>✕</button>
        </div>
      ))}
      {adding ? (
        <div className="cdp-add-sig">
          <input className="cdp-inp" placeholder="Full name"
            value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input className="cdp-inp" placeholder="Email"
            value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          <div className="cdp-row2">
            <select className="cdp-inp" value={form.signatoryType}
              onChange={e => setForm({ ...form, signatoryType: e.target.value })}>
              <option value="external">External</option>
              <option value="internal">Internal</option>
            </select>
            <select className="cdp-inp" value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}>
              <option value="signer">Signer</option>
              <option value="counter_signer">Counter-signer</option>
              <option value="cc">CC</option>
            </select>
          </div>
          <div className="cdp-inline-btns">
            <button className="cdp-inline-ok" onClick={add} disabled={saving}>
              {saving ? '…' : 'Add'}
            </button>
            <button className="cdp-inline-cancel" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="cdp-add-sig-btn" onClick={() => setAdding(true)}>+ Add signatory</button>
      )}
    </div>
  );
}

// ── Timeline tab ──────────────────────────────────────────────────────────────

function TimelineTab({ events }) {
  if (!events.length) return <div className="cdp-empty-tab">No events yet.</div>;
  return (
    <div className="cdp-timeline">
      {events.map(ev => (
        <div key={ev.id} className="cdp-ev">
          <div className="cdp-ev-icon">{EV_ICONS[ev.event_type] || '📋'}</div>
          <div className="cdp-ev-body">
            <div className="cdp-ev-type">{ev.event_type.replace(/_/g, ' ')}</div>
            {ev.first_name && (
              <div className="cdp-ev-actor">{ev.first_name} {ev.last_name}</div>
            )}
            {(ev.payload?.note || ev.payload?.comment || ev.payload?.reason) && (
              <div className="cdp-ev-note">
                {ev.payload.note || ev.payload.comment || `Reason: ${ev.payload.reason}`}
              </div>
            )}
          </div>
          <div className="cdp-ev-time">{fmt(ev.created_at)}</div>
        </div>
      ))}
    </div>
  );
}
