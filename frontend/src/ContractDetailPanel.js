// ContractDetailPanel.js
import React, { useState } from 'react';
import { apiService } from './apiService';
import DocumentVersionsPanel from './DocumentVersionsPanel';
import LegalReviewPanel from './LegalReviewPanel';
import './ContractDetailPanel.css';

const STEPS = ['draft','in_legal_review','with_sales','in_signatures','signed','active'];
const STEP_LABELS = {
  draft:'Draft', in_legal_review:'Legal Review', with_sales:'With Sales',
  in_signatures:'Signatures', signed:'Signed', active:'Active',
};
const STATUS_COLORS = {
  draft:{bg:'#f1f5f9',text:'#475569'}, in_legal_review:{bg:'#fef3c7',text:'#92400e'},
  with_sales:{bg:'#dbeafe',text:'#1e40af'}, in_signatures:{bg:'#ede9fe',text:'#5b21b6'},
  signed:{bg:'#dcfce7',text:'#14532d'}, active:{bg:'#d1fae5',text:'#065f46'},
  expired:{bg:'#f3f4f6',text:'#6b7280'}, void:{bg:'#fee2e2',text:'#991b1b'},
};
const TYPE_LABELS = {
  nda:'NDA',msa:'MSA',sow:'SOW',order_form:'Order Form',amendment:'Amendment',custom:'Custom',
};
const APPR_COLORS = {
  not_started:{bg:'#f1f5f9',text:'#94a3b8',label:'Not started'},
  pending:    {bg:'#fef3c7',text:'#92400e',label:'Pending'},
  approved:   {bg:'#d1fae5',text:'#065f46',label:'Approved'},
  rejected:   {bg:'#fee2e2',text:'#991b1b',label:'Rejected'},
};
const EV_ICONS = {
  draft_created:'✏️', submitted_for_legal_review:'📤', legal_picked_up:'👋',
  legal_reassigned:'↔️', returned_to_sales:'📥', document_version_uploaded:'📎',
  resubmitted_to_legal:'🔄', internal_approval_started:'🔐',
  internal_approval_step_approved:'✅', internal_approval_rejected:'❌',
  internal_fully_approved:'🎉', internal_approval_auto_approved:'⚡',
  sent_for_signature:'✍️', signed_by_external:'📝', activated:'🚀',
  expired:'⌛', voided:'🚫', recalled:'↩️', amendment_created:'📄',
  amendment_spawned:'🌿', note_added:'💬',
};

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'});
}

function ActionBtn({ label, variant='default', onClick, disabled, loading }) {
  return (
    <button
      className={`cdp-btn cdp-btn--${variant}`}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? '…' : label}
    </button>
  );
}

// ── Inline confirmation widget ────────────────────────────────────────
function ConfirmInline({ placeholder, onConfirm, onCancel, confirmLabel='Confirm', danger }) {
  const [val, setVal] = useState('');
  return (
    <div className="cdp-inline-confirm">
      <input className="cdp-inline-input" placeholder={placeholder} value={val}
        onChange={e => setVal(e.target.value)} />
      <div className="cdp-inline-btns">
        <button className={`cdp-inline-ok ${danger ? 'cdp-inline-ok--danger' : ''}`}
          onClick={() => onConfirm(val)}>{confirmLabel}</button>
        <button className="cdp-inline-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function ContractDetailPanel({ contract: c, isLegalMember, onClose, onUpdated }) {
  const [tab, setTab]                 = useState('details');
  const [busy, setBusy]               = useState('');
  const [err, setErr]                 = useState('');
  const [showVoid, setShowVoid]       = useState(false);
  const [showRecall, setShowRecall]   = useState(false);

  const sc   = STATUS_COLORS[c.status] || STATUS_COLORS.draft;
  const sidx = STEPS.indexOf(c.status);
  const ac   = APPR_COLORS[c.internalApprovalStatus] || APPR_COLORS.not_started;

  async function act(key, fn) {
    setBusy(key); setErr('');
    try { await fn(); onUpdated(); }
    catch (e) { setErr(e.response?.data?.error?.message || e.message || 'Action failed'); }
    finally { setBusy(''); }
  }

  // ── Context action buttons per status ────────────────────────────
  function Actions() {
    const id = c.id;
    const terminal = ['void','expired'].includes(c.status);

    return (
      <div className="cdp-actions">
        {err && <div className="cdp-err">{err}</div>}

        {c.status === 'draft' && <>
          <ActionBtn label="Submit for Legal Review" variant="primary"
            loading={busy==='submit'}
            onClick={() => act('submit', () => apiService.contracts.submitForLegal(id, {}))} />
          <ActionBtn label="Start Internal Approval" variant="secondary"
            loading={busy==='approval'}
            onClick={() => act('approval', () => apiService.contracts.startApproval(id))} />
          <ActionBtn label="Delete" variant="danger"
            loading={busy==='del'}
            onClick={() => act('del', async () => { await apiService.contracts.delete(id); onClose(); })} />
        </>}

        {c.status === 'in_legal_review' && isLegalMember && <>
          {c.legalQueue && <ActionBtn label="Pick Up" variant="primary"
            loading={busy==='pickup'}
            onClick={() => act('pickup', () => apiService.contracts.pickUp(id))} />}
          <ActionBtn label="Return to Sales" variant="secondary"
            loading={busy==='return'}
            onClick={() => act('return', () => apiService.contracts.returnToSales(id))} />
        </>}
        {c.status === 'in_legal_review' && !isLegalMember &&
          <ActionBtn label="Recall to Draft" variant="warning"
            onClick={() => setShowRecall(true)} />}

        {c.status === 'with_sales' && <>
          <ActionBtn label="Resubmit to Legal" variant="secondary"
            loading={busy==='resubmit'}
            onClick={() => act('resubmit', () => apiService.contracts.resubmit(id))} />
          <ActionBtn
            label={c.internalApprovalStatus !== 'approved'
              ? 'Send for Signature ⚠️' : 'Send for Signature'}
            variant={c.internalApprovalStatus === 'approved' ? 'primary' : 'warning'}
            loading={busy==='send'}
            onClick={() => act('send', () => apiService.contracts.sendForSignature(id))} />
          {c.internalApprovalStatus === 'not_started' &&
            <ActionBtn label="Start Internal Approval" variant="secondary"
              loading={busy==='approval'}
              onClick={() => act('approval', () => apiService.contracts.startApproval(id))} />}
        </>}

        {c.status === 'in_signatures' && <>
          <ActionBtn label="Mark as Signed" variant="primary"
            loading={busy==='signed'}
            onClick={() => act('signed', () => apiService.contracts.markSigned(id))} />
          <ActionBtn label="Recall" variant="warning"
            onClick={() => setShowRecall(true)} />
        </>}

        {c.status === 'signed' &&
          <ActionBtn label="Activate" variant="primary"
            loading={busy==='activate'}
            onClick={() => act('activate', () => apiService.contracts.activate(id))} />}

        {c.status === 'active' &&
          <ActionBtn label="Amend" variant="secondary"
            loading={busy==='amend'}
            onClick={() => act('amend', () => apiService.contracts.amend(id))} />}

        {!terminal &&
          <ActionBtn label="Void" variant="danger"
            onClick={() => setShowVoid(true)} />}

        {showVoid && <ConfirmInline
          placeholder="Reason for voiding (optional)"
          confirmLabel="Confirm Void" danger
          onConfirm={reason => { setShowVoid(false); act('void', () => apiService.contracts.void(id, {reason})); }}
          onCancel={() => setShowVoid(false)} />}

        {showRecall && <ConfirmInline
          placeholder="Reason for recall (optional)"
          confirmLabel="Confirm Recall"
          onConfirm={reason => { setShowRecall(false); act('recall', () => apiService.contracts.recall(id, {reason})); }}
          onCancel={() => setShowRecall(false)} />}
      </div>
    );
  }

  const TABS = [
    {id:'details',label:'Details'},{id:'document',label:'Document'},
    {id:'legal',label:'Legal'},{id:'approvals',label:'Approvals'},
    {id:'signatories',label:'Signatories'},{id:'timeline',label:'Timeline'},
  ];

  return (
    <div className="cdp-wrap">
      {/* Header */}
      <div className="cdp-header">
        <div className="cdp-header-row">
          <div className="cdp-badges">
            <span className="cdp-type-badge">{TYPE_LABELS[c.contractType]||c.contractType}</span>
            <span className="cdp-status-badge" style={{background:sc.bg,color:sc.text}}>
              {STEP_LABELS[c.status]||c.status}
            </span>
          </div>
          <button className="cdp-close" onClick={onClose}>✕</button>
        </div>
        <h2 className="cdp-title">{c.title}</h2>
        <div className="cdp-subtitle">
          {c.customerLegalName && <span>{c.customerLegalName}</span>}
          {c.companyEntity && <span> · {c.companyEntity}</span>}
          {c.value && <span> · {c.currency} {Number(c.value).toLocaleString()}</span>}
          {c.dealName && <span> · 📂 {c.dealName}</span>}
        </div>
      </div>

      {/* Workflow stepper */}
      <div className="cdp-stepper">
        {STEPS.map((s, i) => {
          const active = s === c.status;
          const done   = sidx > i && !['void','expired'].includes(c.status);
          return (
            <React.Fragment key={s}>
              {i > 0 && <div className={`cdp-line ${done||active?'cdp-line--on':''}`} />}
              <div className={`cdp-step ${active?'cdp-step--cur':''} ${done?'cdp-step--done':''}`}>
                <div className="cdp-dot">{done ? '✓' : i+1}</div>
                <div className="cdp-step-lbl">{STEP_LABELS[s]}</div>
              </div>
            </React.Fragment>
          );
        })}
        {['void','expired'].includes(c.status) && (
          <div className="cdp-terminal" style={{background:sc.bg,color:sc.text}}>
            {c.status==='void'?'🚫 Void':'⌛ Expired'}
          </div>
        )}
      </div>

      {/* Approval track */}
      <div className="cdp-appr-bar">
        <span className="cdp-appr-lbl">Internal Approval:</span>
        <span className="cdp-appr-pill" style={{background:ac.bg,color:ac.text}}>{ac.label}</span>
        {c.internalApprovalStatus==='not_started' && !['void','expired'].includes(c.status) && (
          <button className="cdp-appr-start"
            onClick={() => act('approval', () => apiService.contracts.startApproval(c.id))}>
            Start
          </button>
        )}
      </div>

      <Actions />

      {/* Inner tabs */}
      <div className="cdp-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`cdp-tab ${tab===t.id?'cdp-tab--on':''}`}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="cdp-body">
        {tab==='details'     && <DetailsTab c={c} onUpdated={onUpdated} />}
        {tab==='document'    && <DocumentVersionsPanel contract={c} onUpdated={onUpdated} />}
        {tab==='legal'       && <LegalReviewPanel contract={c} isLegalMember={isLegalMember} onUpdated={onUpdated} />}
        {tab==='approvals'   && <ApprovalsTab c={c} onUpdated={onUpdated} />}
        {tab==='signatories' && <SignatoriesTab c={c} onUpdated={onUpdated} />}
        {tab==='timeline'    && <TimelineTab events={c.events||[]} />}
      </div>
    </div>
  );
}

// ── Details ───────────────────────────────────────────────────────────
function DetailsTab({ c, onUpdated }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState({});
  const [saving, setSaving]   = useState(false);

  function startEdit() {
    setForm({
      title: c.title, value: c.value||'', currency: c.currency,
      customerLegalName: c.customerLegalName||'', companyEntity: c.companyEntity||'',
      effectiveDate: c.effectiveDate?.split('T')[0]||'',
      expiryDate: c.expiryDate?.split('T')[0]||'', arrImpact: c.arrImpact||false,
    });
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      await apiService.contracts.update(c.id, form);
      setEditing(false); onUpdated();
    } catch (e) { alert(e.response?.data?.error?.message || 'Save failed'); }
    finally { setSaving(false); }
  }

  if (editing) return (
    <div className="cdp-edit">
      <label className="cdp-lbl">Title<input className="cdp-inp" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} /></label>
      <div className="cdp-row2">
        <label className="cdp-lbl">Value<input className="cdp-inp" type="number" value={form.value} onChange={e=>setForm({...form,value:e.target.value})} /></label>
        <label className="cdp-lbl">Currency<input className="cdp-inp" value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})} /></label>
      </div>
      <label className="cdp-lbl">Customer Legal Name<input className="cdp-inp" value={form.customerLegalName} onChange={e=>setForm({...form,customerLegalName:e.target.value})} /></label>
      <label className="cdp-lbl">Company Entity<input className="cdp-inp" value={form.companyEntity} onChange={e=>setForm({...form,companyEntity:e.target.value})} /></label>
      <div className="cdp-row2">
        <label className="cdp-lbl">Effective Date<input className="cdp-inp" type="date" value={form.effectiveDate} onChange={e=>setForm({...form,effectiveDate:e.target.value})} /></label>
        <label className="cdp-lbl">Expiry Date<input className="cdp-inp" type="date" value={form.expiryDate} onChange={e=>setForm({...form,expiryDate:e.target.value})} /></label>
      </div>
      {c.contractType==='amendment' && (
        <label className="cdp-check"><input type="checkbox" checked={form.arrImpact} onChange={e=>setForm({...form,arrImpact:e.target.checked})} /> Change in ARR</label>
      )}
      <div className="cdp-edit-btns">
        <button className="cdp-save" onClick={save} disabled={saving}>{saving?'Saving…':'Save'}</button>
        <button className="cdp-cancel" onClick={()=>setEditing(false)}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="cdp-section-hd">
        <span className="cdp-section-ttl">Contract Details</span>
        {c.status==='draft' && <button className="cdp-edit-btn" onClick={startEdit}>Edit</button>}
      </div>
      <div className="cdp-grid">
        <div className="cdp-field"><div className="cdp-fk">Owner</div><div className="cdp-fv">{c.ownerName||'—'}</div></div>
        <div className="cdp-field"><div className="cdp-fk">Type</div><div className="cdp-fv">{c.contractType}</div></div>
        {c.value && <div className="cdp-field"><div className="cdp-fk">Value</div><div className="cdp-fv">{c.currency} {Number(c.value).toLocaleString()}</div></div>}
        <div className="cdp-field"><div className="cdp-fk">Customer Entity</div><div className="cdp-fv">{c.customerLegalName||'—'}</div></div>
        <div className="cdp-field"><div className="cdp-fk">Company Entity</div><div className="cdp-fv">{c.companyEntity||'—'}</div></div>
        <div className="cdp-field"><div className="cdp-fk">Effective Date</div><div className="cdp-fv">{fmt(c.effectiveDate)}</div></div>
        <div className="cdp-field"><div className="cdp-fk">Expiry Date</div><div className="cdp-fv">{fmt(c.expiryDate)}</div></div>
        {c.contractType==='amendment' && <div className="cdp-field"><div className="cdp-fk">ARR Impact</div><div className="cdp-fv">{c.arrImpact?'Yes':'No'}</div></div>}
        <div className="cdp-field"><div className="cdp-fk">Created</div><div className="cdp-fv">{fmt(c.createdAt)}</div></div>
      </div>
      {(c.parentContractId || c.children?.length > 0) && (
        <div className="cdp-hierarchy">
          <div className="cdp-section-ttl" style={{marginBottom:6}}>Hierarchy</div>
          {c.parentContractId && <div className="cdp-hier-up">↑ Parent: {c.parentTitle} ({c.parentType})</div>}
          {c.children?.map(ch => <div key={ch.id} className="cdp-hier-dn">└─ {ch.title}</div>)}
        </div>
      )}
    </div>
  );
}

// ── Approvals ─────────────────────────────────────────────────────────
function ApprovalsTab({ c, onUpdated }) {
  const [deciding, setDeciding] = useState(null);
  const [note, setNote]         = useState('');
  const [busy, setBusy]         = useState('');

  async function decide(id, decision) {
    setBusy(id+decision);
    try {
      await apiService.contracts.decideApproval(id, decision, note);
      setDeciding(null); setNote(''); onUpdated();
    } catch (e) { alert(e.response?.data?.error?.message||'Failed'); }
    finally { setBusy(''); }
  }

  const approvals = c.approvals||[];
  if (!approvals.length) return (
    <div className="cdp-empty-tab">
      No approval chain configured.
      {!['void','expired'].includes(c.status) && (
        <button className="cdp-tab-btn"
          onClick={() => apiService.contracts.startApproval(c.id).then(onUpdated).catch(e=>alert(e.message))}>
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
          {a.status==='pending' && deciding!==a.id && (
            <button className="cdp-decide-btn" onClick={()=>setDeciding(a.id)}>Decide</button>
          )}
          {deciding===a.id && (
            <div className="cdp-decide-form">
              <input className="cdp-inline-input" placeholder="Note (optional)" value={note}
                onChange={e=>setNote(e.target.value)} />
              <div className="cdp-inline-btns">
                <button className="cdp-inline-ok" onClick={()=>decide(a.id,'approved')} disabled={!!busy}>Approve</button>
                <button className="cdp-inline-ok cdp-inline-ok--danger" onClick={()=>decide(a.id,'rejected')} disabled={!!busy}>Reject</button>
                <button className="cdp-inline-cancel" onClick={()=>setDeciding(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Signatories ───────────────────────────────────────────────────────
function SignatoriesTab({ c, onUpdated }) {
  const [form, setForm]     = useState({name:'',email:'',signatoryType:'external',role:'signer'});
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  async function add() {
    setSaving(true);
    try { await apiService.contracts.addSignatory(c.id,form); setAdding(false); setForm({name:'',email:'',signatoryType:'external',role:'signer'}); onUpdated(); }
    catch (e) { alert(e.message); } finally { setSaving(false); }
  }
  async function remove(sid) {
    if (!window.confirm('Remove signatory?')) return;
    try { await apiService.contracts.removeSignatory(c.id,sid); onUpdated(); }
    catch (e) { alert(e.message); }
  }

  return (
    <div className="cdp-sigs">
      {(c.signatories||[]).map(s => (
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
          <button className="cdp-rm-btn" onClick={()=>remove(s.id)}>✕</button>
        </div>
      ))}
      {adding ? (
        <div className="cdp-add-sig">
          <input className="cdp-inp" placeholder="Full name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
          <input className="cdp-inp" placeholder="Email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} />
          <div className="cdp-row2">
            <select className="cdp-inp" value={form.signatoryType} onChange={e=>setForm({...form,signatoryType:e.target.value})}>
              <option value="external">External</option><option value="internal">Internal</option>
            </select>
            <select className="cdp-inp" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
              <option value="signer">Signer</option><option value="counter_signer">Counter-signer</option><option value="cc">CC</option>
            </select>
          </div>
          <div className="cdp-inline-btns">
            <button className="cdp-inline-ok" onClick={add} disabled={saving}>{saving?'…':'Add'}</button>
            <button className="cdp-inline-cancel" onClick={()=>setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="cdp-add-sig-btn" onClick={()=>setAdding(true)}>+ Add signatory</button>
      )}
    </div>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────
function TimelineTab({ events }) {
  if (!events.length) return <div className="cdp-empty-tab">No events yet.</div>;
  return (
    <div className="cdp-timeline">
      {events.map(ev => (
        <div key={ev.id} className="cdp-ev">
          <div className="cdp-ev-icon">{EV_ICONS[ev.event_type]||'📋'}</div>
          <div className="cdp-ev-body">
            <div className="cdp-ev-type">{ev.event_type.replace(/_/g,' ')}</div>
            {ev.first_name && <div className="cdp-ev-actor">{ev.first_name} {ev.last_name}</div>}
            {(ev.payload?.note||ev.payload?.comment||ev.payload?.reason) && (
              <div className="cdp-ev-note">
                {ev.payload.note||ev.payload.comment||`Reason: ${ev.payload.reason}`}
              </div>
            )}
          </div>
          <div className="cdp-ev-time">{fmt(ev.created_at)}</div>
        </div>
      ))}
    </div>
  );
}
