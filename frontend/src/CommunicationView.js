/*
 * CommunicationView.js
 *
 * WORKFLOW → Communication. One place for every channel, replacing the separate
 * "Email" nav entry.
 *
 * WHY CONSOLIDATE
 *   Channels were scattered: Email had its own nav item, WhatsApp lived only
 *   inside individual projects, and calls were reachable only from a contact.
 *   Someone asking "what did we say to Acme last week" had three places to look
 *   and no way to see across them. Tabs here, filters inside each — triage is a
 *   state, not a destination.
 *
 * WIRING
 *   Replace the "Email" item under WORKFLOW in the left nav with this. The
 *   Emails tab renders the existing EmailView unchanged, so nothing about the
 *   email experience changes.
 *
 *   PROPS ARE PASS-THROUGH. App.js deep-links into email from a deal via
 *   dealId / onDealFilterApplied. Those must reach EmailView or "view emails
 *   for this deal" silently stops filtering — the page still renders, just
 *   with the wrong contents, which is worse than an error.
 */

import React, { useState, useEffect } from 'react';
import { hashSegment, writeHash } from './hashNav';
import EmailView from './EmailView';
import CommunicationMessages from './CommunicationMessages';

const TABS = [
  { key: 'emails',   label: 'Emails' },
  { key: 'messages', label: 'Messages' },
  { key: 'calls',    label: 'Calls' },
];

export default function CommunicationView({ dealId, onDealFilterApplied }) {
  // Deep links from a deal ("show me the email for this deal") arrive as a
  // dealId prop. Land on Emails when one is present, or the user follows the
  // link and sees an unrelated tab.
  // Segment 1 is ours (App owns segment 0 — see hashNav.js). Reading it on
  // mount is what makes #/email/messages a shareable link rather than something
  // that always lands on Emails.
  const [tab, setTab] = useState(() => {
    const seg = hashSegment(1);
    return TABS.some(t => t.key === seg) ? seg : 'emails';
  });

  useEffect(() => { if (dealId) setTab('emails'); }, [dealId]);

  // Write our segment and TRUNCATE below it: the channel and message segments
  // belong to the Messages tab and are meaningless once you leave it.
  useEffect(() => {
    if (hashSegment(1) !== tab) writeHash(['email', tab]);
  }, [tab]);

  // Someone editing the URL, or following a link while already in the app.
  useEffect(() => {
    const onHash = () => {
      const seg = hashSegment(1);
      if (TABS.some(t => t.key === seg) && seg !== tab) setTab(seg);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [tab]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 18 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '9px 16px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? '#E8630A' : '#6b7280',
              borderBottom: tab === t.key ? '2px solid #E8630A' : '2px solid transparent',
              marginBottom: -1,
            }}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'emails'   && <EmailView dealId={dealId} onDealFilterApplied={onDealFilterApplied} />}
      {tab === 'messages' && <CommunicationMessages />}
      {tab === 'calls'    && <CallsPlaceholder />}
    </div>
  );
}

/*
 * Calls are not built yet. A visible, honest placeholder beats a hidden tab:
 * it tells people the channel is coming rather than leaving them to wonder
 * whether call history exists somewhere they have not found.
 *
 * When it is built, the data is already there — twilio call logs joined to
 * contacts and projects, filtered by the same project-membership rule the
 * Messages tab uses.
 */
function CallsPlaceholder() {
  return (
    <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13, border: '1px dashed #e5e7eb', borderRadius: 8 }}>
      Call history is not in this view yet. Calls are still logged against contacts and projects.
    </div>
  );
}
