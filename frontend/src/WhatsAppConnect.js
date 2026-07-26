/*
 * WhatsAppConnect.js
 *
 * Org Admin panel to connect / disconnect the org's WhatsApp Business Account.
 *
 * Unlike Slack (OAuth), the direct Cloud API path is a manual credential entry:
 * the admin pastes the WABA id, phone number id, system-user token and app
 * secret from Meta. Posts to apiService.whatsapp.connect; the token is
 * encrypted server-side and never returned (status shows only the last 4).
 *
 * When you move to the platform / Embedded Signup model, this form is replaced
 * by a "Connect with Facebook" button — the same endpoint receives the exchanged
 * token, so nothing downstream changes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const WEBHOOK_PATH = '/webhooks/whatsapp';

const EMPTY = {
  wabaId: '', phoneNumberId: '', accessToken: '', appSecret: '',
  displayPhoneNumber: '', verifiedName: '', businessId: '',
  webhookVerifyToken: '', isOfficialBusinessAccount: false, groupsEnabled: false,
};

export default function WhatsAppConnect() {
  const [status,  setStatus]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [form,    setForm]    = useState(EMPTY);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiService.whatsapp.account();
      setStatus(res.data || { connected: false });
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) =>
    setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const handleConnect = async () => {
    setError(''); setSuccess('');
    if (!form.wabaId || !form.phoneNumberId || !form.accessToken) {
      setError('WABA ID, Phone Number ID and Access Token are required.');
      return;
    }
    setBusy(true);
    try {
      const res = await apiService.whatsapp.connect(form);
      setStatus(res.data);
      setForm(EMPTY);
      setSuccess('WhatsApp Business account connected.');
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Failed to connect WhatsApp.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect WhatsApp? Delivery threads keep their history, but no new messages can be sent or received until you reconnect.')) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await apiService.whatsapp.disconnect();
      setStatus({ connected: false });
      setSuccess('WhatsApp disconnected.');
    } catch {
      setError('Failed to disconnect WhatsApp.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading WhatsApp settings…</div>;

  const webhookUrl = (typeof window !== 'undefined' ? window.location.origin : 'https://gowarmcrm.com') + WEBHOOK_PATH;
  const label = { fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, display: 'block', marginBottom: 4 };
  const input = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' };
  const field = { marginBottom: 12 };

  return (
    <div style={{ maxWidth: 620 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1a202c' }}>WhatsApp Business</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
        Connect this org's WhatsApp Business Account (Meta Cloud API) to send and
        receive on delivery threads. Credentials are encrypted at rest.
      </p>

      {error   && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, color: '#991b1b' }}>{error}</div>}
      {success && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 13, color: '#166534' }}>{success}</div>}

      {status?.connected ? (
        <div style={{ padding: 16, border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#166534', marginBottom: 8 }}>
            ✅ Connected{status.verifiedName ? ` — ${status.verifiedName}` : ''}
          </div>
          <div style={{ fontSize: 13, color: '#374151', display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 4, columnGap: 12 }}>
            {status.displayPhoneNumber && <div><span style={{ color: '#6b7280' }}>Number: </span><strong>{status.displayPhoneNumber}</strong></div>}
            {status.provider && <div><span style={{ color: '#6b7280' }}>Provider: </span><strong>{status.provider}</strong></div>}
            {status.messagingLimitTier && <div><span style={{ color: '#6b7280' }}>Tier: </span><strong>{status.messagingLimitTier}</strong></div>}
            {status.qualityRating && <div><span style={{ color: '#6b7280' }}>Quality: </span><strong>{status.qualityRating}</strong></div>}
            <div><span style={{ color: '#6b7280' }}>OBA: </span><strong>{status.isOfficialBusinessAccount ? 'Yes' : 'No'}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Groups: </span><strong>{status.groupsEnabled ? 'Enabled' : 'Off'}</strong></div>
            {status.tokenLast4 && <div><span style={{ color: '#6b7280' }}>Token: </span><strong>••••{status.tokenLast4}</strong></div>}
          </div>
          <button onClick={handleDisconnect} disabled={busy} style={{
            marginTop: 14, padding: '8px 16px', borderRadius: 6, border: '1px solid #fecaca',
            background: '#fff', color: '#991b1b', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
            {busy ? '…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <div>
          <div style={field}>
            <label style={label}>WABA ID *</label>
            <input style={input} value={form.wabaId} onChange={set('wabaId')} placeholder="WhatsApp Business Account ID" />
          </div>
          <div style={field}>
            <label style={label}>Phone Number ID *</label>
            <input style={input} value={form.phoneNumberId} onChange={set('phoneNumberId')} placeholder="From API Setup → phone number id" />
          </div>
          <div style={field}>
            <label style={label}>System-User Access Token *</label>
            <input style={input} type="password" value={form.accessToken} onChange={set('accessToken')} placeholder="Permanent token with whatsapp_business_messaging scope" autoComplete="off" />
          </div>
          <div style={field}>
            <label style={label}>App Secret</label>
            <input style={input} type="password" value={form.appSecret} onChange={set('appSecret')} placeholder="For webhook signature verification (recommended)" autoComplete="off" />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ ...field, flex: 1 }}>
              <label style={label}>Display Phone Number</label>
              <input style={input} value={form.displayPhoneNumber} onChange={set('displayPhoneNumber')} placeholder="+91 98xxxxxxx" />
            </div>
            <div style={{ ...field, flex: 1 }}>
              <label style={label}>Verified Name</label>
              <input style={input} value={form.verifiedName} onChange={set('verifiedName')} placeholder="Name recipients see" />
            </div>
          </div>
          <div style={field}>
            <label style={label}>Webhook Verify Token</label>
            <input style={input} value={form.webhookVerifyToken} onChange={set('webhookVerifyToken')} placeholder="The token you set in Meta's webhook config" />
          </div>
          <div style={{ display: 'flex', gap: 20, margin: '4px 0 16px' }}>
            <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.isOfficialBusinessAccount} onChange={set('isOfficialBusinessAccount')} />
              Official Business Account
            </label>
            <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.groupsEnabled} onChange={set('groupsEnabled')} />
              Enable groups (needs OBA)
            </label>
          </div>

          <div style={{ padding: '10px 12px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
            In Meta's webhook config, point the callback URL at{' '}
            <strong style={{ color: '#374151' }}>{webhookUrl}</strong> and subscribe to the <strong>messages</strong> field.
          </div>

          <button onClick={handleConnect} disabled={busy} style={{
            padding: '9px 18px', borderRadius: 6, border: 'none',
            background: busy ? '#9ca3af' : '#16a34a', color: '#fff', fontSize: 14, fontWeight: 600,
            cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Connecting…' : 'Connect WhatsApp'}
          </button>
        </div>
      )}
    </div>
  );
}
