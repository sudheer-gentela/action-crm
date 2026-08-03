/**
 * OAStorage.js
 *
 * DROP-IN LOCATION: frontend/src/orgadmin/panels/OAStorage.js  (NEW FILE)
 *
 * Where WhatsApp attachments get written.
 *
 * The number is on the WhatsApp Cloud API, so it cannot also be in the consumer
 * or Business app — there is no inbox anywhere. An attachment GoWarm does not
 * capture is unreachable by anyone, and Meta drops it after about 30 days. So
 * this screen is not optional configuration; without it, files are lost.
 *
 * WHICH ACCOUNT is shown prominently on purpose. The common mistake is an admin
 * clicking Connect while still signed in as themselves, silently wiring up
 * their own OneDrive — and naming the connected account is the only way that is
 * visible.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const PROVIDERS = [
  {
    key: 'onedrive',
    name: 'OneDrive',
    // Items belong to the drive they sit in, so a durable account's folder
    // genuinely protects the files.
    why: 'Files belong to whichever OneDrive they sit in, so connect a service account — or an admin account that will not be deleted. Files survive the person who uploaded them leaving.',
  },
  {
    key: 'googledrive',
    name: 'Google Drive',
    // In My Drive the UPLOADER owns the file even when it lands in someone
    // else's folder, so only a Shared Drive actually protects it.
    why: 'If your project folders are on a Shared Drive you do not need this — the drive already owns its files. Connect an account only if project folders live in someone\u2019s My Drive, where files leave with their uploader.',
  },
];

const S = {
  card:  { border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, marginBottom: 14 },
  h4:    { margin: '0 0 4px', fontSize: 14, color: '#374151' },
  why:   { fontSize: 12, color: '#6b7280', margin: '0 0 10px', lineHeight: 1.5 },
  row:   { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  btn:   { fontSize: 12, padding: '5px 11px', borderRadius: 5, border: '1px solid #d1d5db',
           background: '#fff', color: '#374151', cursor: 'pointer' },
  pri:   { fontSize: 12, padding: '5px 11px', borderRadius: 5, border: 'none',
           background: '#0369a1', color: '#fff', cursor: 'pointer' },
  meta:  { fontSize: 11, color: '#6b7280' },
  err:   { padding: '8px 10px', background: '#fee2e2', color: '#991b1b',
           borderRadius: 6, fontSize: 12, marginBottom: 10 },
  warn:  { padding: '8px 10px', background: '#fef3c7', color: '#92400e',
           borderRadius: 6, fontSize: 12, margin: '8px 0' },
  okBox: { padding: '8px 10px', background: '#dcfce7', color: '#065f46',
           borderRadius: 6, fontSize: 12, marginBottom: 10 },
  pill:  (bg, fg) => ({ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                        background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.3 }),
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function readIdentity() {
  try {
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    return { userId: u.id || u.userId || null, orgId: u.org_id || u.orgId || null };
  } catch { return { userId: null, orgId: null }; }
}

function ProviderCard({ provider, account, onConnect, onDisconnect, busy }) {
  const broken = account && !account.is_active;

  return (
    <div style={S.card}>
      <h4 style={S.h4}>{provider.name}</h4>
      <p style={S.why}>{provider.why}</p>

      {!account && (
        <div style={S.row}>
          <span style={S.meta}>Not connected — attachments are not being saved.</span>
          <button style={{ ...S.pri, marginLeft: 'auto' }} disabled={busy}
            onClick={() => onConnect(provider.key)}>Connect {provider.name}</button>
        </div>
      )}

      {account && (
        <>
          <div style={S.row}>
            <strong style={{ fontSize: 13 }}>{account.email || '(no address recorded)'}</strong>
            {broken
              ? <span style={S.pill('#fee2e2', '#991b1b')}>needs reconnecting</span>
              : <span style={S.pill('#dcfce7', '#065f46')}>connected</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button style={S.btn} disabled={busy} onClick={() => onConnect(provider.key)}>
                {broken ? 'Reconnect' : 'Change account'}
              </button>
              <button style={S.btn} disabled={busy} onClick={() => onDisconnect(provider.key)}>
                Disconnect
              </button>
            </div>
          </div>

          <div style={{ ...S.meta, marginTop: 6 }}>
            {account.connected_by_name && <>Connected by {account.connected_by_name}. </>}
            {account.last_used_at && <>Last used {new Date(account.last_used_at).toLocaleDateString()}.</>}
          </div>

          {broken && (
            <div style={S.warn}>
              ⚠️ {account.last_error || 'The connection failed.'} Attachments are not being saved
              while this is broken, and WhatsApp deletes them after about 30 days — anything that
              arrives before you reconnect will be lost.
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function OAStorage() {
  const [accounts, setAccounts] = useState({});
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState('');
  const [notice,   setNotice]   = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await apiService.orgStorage.list();
      setAccounts(r.data.accounts || {});
    } catch (e) { setErr(errText(e, 'Could not load storage settings.')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The OAuth callback returns to the app root with these params. Surfacing the
  // account name here is what makes "I connected the wrong account" visible.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('storage_connected');
    if (connected) {
      const who = params.get('account');
      setNotice(
        `Connected ${connected === 'onedrive' ? 'OneDrive' : 'Google Drive'}`
        + (who ? ` as ${who} — check this is the account you intended.` : '.')
      );
      load();
    } else if (params.get('error') === 'storage_connect_failed') {
      setErr('That connection did not complete. Nothing was changed.');
    }
  }, [load]);

  const connect = async (providerKey) => {
    setErr(''); setBusy(true);
    try {
      const { userId, orgId } = readIdentity();
      if (!userId || !orgId) throw new Error('Could not identify your account. Reload and try again.');
      const r = await apiService.orgStorage.connectUrl(providerKey, userId, orgId);
      const url = r.data.authUrl || r.data.url;
      if (!url) throw new Error('No authorization URL returned.');
      window.location.href = url;
    } catch (e) { setErr(errText(e, e.message || 'Could not start the connection.')); setBusy(false); }
  };

  const disconnect = async (providerKey) => {
    if (!window.confirm(
      'Disconnect this account?\n\n'
      + 'Files already saved stay where they are — they are in your storage, not ours. '
      + 'New WhatsApp attachments will stop being saved.')) return;
    setErr(''); setBusy(true);
    try { await apiService.orgStorage.disconnect(providerKey); await load(); }
    catch (e) { setErr(errText(e, 'Could not disconnect.')); }
    finally { setBusy(false); }
  };

  if (loading) return <div style={S.meta}>Loading…</div>;

  const anyActive = PROVIDERS.some(p => accounts[p.key]?.is_active);

  return (
    <div style={{ padding: 4 }}>
      {err    && <div style={S.err}>⚠️ {err}</div>}
      {notice && <div style={S.okBox}>✅ {notice}</div>}

      <p style={{ ...S.why, marginBottom: 14 }}>
        Documents, photos and video shared in a project&rsquo;s WhatsApp group are written into your
        own cloud storage, into the folder mapped to that project. Nothing is stored by GoWarm.
        Sign in as the account you want to own those files &mdash; not necessarily your own.
      </p>

      {!anyActive && (
        <div style={S.warn}>
          No storage connected, so WhatsApp attachments are not being saved. The number is on the
          WhatsApp Business API and has no app inbox, so an attachment that is not captured cannot
          be retrieved by anyone once WhatsApp drops it after about 30 days.
        </div>
      )}

      {PROVIDERS.map(p => (
        <ProviderCard key={p.key} provider={p} account={accounts[p.key]}
          busy={busy} onConnect={connect} onDisconnect={disconnect} />
      ))}

      <p style={S.meta}>
        Each project also needs a folder marked as its upload target &mdash; set that on the
        project&rsquo;s Files tab. Attachments inherit that folder&rsquo;s existing sharing, so the
        project team can already see them.
      </p>
    </div>
  );
}
