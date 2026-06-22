/**
 * utils/domainMatch.js
 *
 * Tiny, dependency-free domain helpers used by email open/click tracking to
 * align a tracking host with the sending address, and to detect when a
 * tracking host lives inside our own platform zone.
 *
 * registrableDomain() approximates the "organizational" domain (eTLD+1). It is
 * NOT a full Public Suffix List implementation — it covers single-label TLDs
 * (.com, .net, .info, .ai, .io, …) plus a compact set of common multi-label
 * suffixes (.co.uk, .com.au, …). That's correct for the domains this product
 * actually sends from; if you ever need exhaustive PSL coverage, swap the body
 * for the `psl` package — the call sites won't change.
 */

'use strict';

// Common two-label public suffixes. Extend as needed; not exhaustive.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.in', 'co.jp', 'co.kr', 'co.za',
  'com.br', 'com.mx', 'com.sg', 'com.hk',
]);

/** Extract the lowercase domain from an email address (or '' if none). */
function emailDomain(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at >= 0 ? s.slice(at + 1) : '';
}

/**
 * Best-effort registrable (organizational) domain.
 *   email.gowarmcrm.com -> gowarmcrm.com
 *   t.gowarm.info       -> gowarm.info
 *   foo.bar.co.uk       -> bar.co.uk
 * Returns '' for empty/garbage input.
 */
function registrableDomain(hostOrDomain) {
  const host = String(hostOrDomain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.')) return host;
  const parts = host.split('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * True when a tracking hostname is aligned with a sender's address — i.e. they
 * share a registrable domain (so the click/link domain sits under the From
 * domain, which is what mailbox providers expect).
 */
function hostAlignsWithSender(host, senderEmailOrDomain) {
  const dom = String(senderEmailOrDomain || '').includes('@')
    ? emailDomain(senderEmailOrDomain)
    : String(senderEmailOrDomain || '').trim().toLowerCase();
  if (!host || !dom) return false;
  return registrableDomain(host) === registrableDomain(dom);
}

module.exports = { emailDomain, registrableDomain, hostAlignsWithSender };
