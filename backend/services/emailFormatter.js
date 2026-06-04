/**
 * emailFormatter.js
 *
 * Shared utility for converting plain-text email bodies to HTML
 * before dispatch via Gmail or Outlook.
 *
 * Used by:
 *   - services/SequenceStepFirer.js   (auto-send branch)
 *   - routes/sequences.routes.js      (draft send endpoint)
 *
 * Why this exists:
 *   Email templates are stored as plain text with \n\n paragraph
 *   breaks. Passing plain text to Gmail/Outlook with isHtml: true
 *   causes the client to collapse all whitespace into one block.
 *   This function converts the stored plain text into proper HTML
 *   so paragraph breaks, line breaks, and URLs render correctly.
 */

/**
 * Converts a plain-text email body to HTML.
 *
 * Rules:
 *   - \n\n (double newline) → <p> paragraph with 14px bottom margin
 *   - \n  (single newline)  → <br> within a paragraph
 *   - http/https URLs, www. hosts, and bare domains (known TLDs) → clickable <a>
 *   - email addresses       → mailto: links
 *   - HTML special chars    → escaped (&amp; &lt; &gt; &quot;)
 *
 * @param {string} text  Plain-text body (may contain \n\n paragraphs)
 * @returns {string}     HTML string safe to pass as isHtml: true body
 */
function plainTextToHtml(text) {
  if (!text) return '';

  // 1. Escape HTML special characters to prevent injection
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 2. Convert links to clickable anchors. One combined pass (so we never
  //    double-link), matching in priority order:
  //      a) explicit http/https URLs        → as-is
  //      b) email addresses                 → mailto:
  //      c) www.-prefixed hosts             → https:// prepended
  //      d) bare domains (e.g. Aquarient.com) with a known TLD → https://
  //    The bare-domain branch uses a TLD allow-list + a lookbehind so it won't
  //    grab the host out of an email, a version string (v1.2), or node.js, and
  //    fixes signatures that list a domain without a scheme.
  const LINK_STYLE = 'color:#1a6fc4;text-decoration:none;';
  const TOKEN_RE =
    /(https?:\/\/[^\s<>"]+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(\bwww\.[^\s<>"]+)|((?<![@\w.])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:com|net|org|io|ai|co|dev|app|info|biz|us|uk|in|me|xyz|tech|so|gg|edu|gov)\b(?:\/[^\s<>"]*)?)/g;
  const linked = escaped.replace(TOKEN_RE, (m, http, email, www, bare) => {
    if (http)  return `<a href="${http}" style="${LINK_STYLE}">${http}</a>`;
    if (email) return `<a href="mailto:${email}" style="${LINK_STYLE}">${email}</a>`;
    if (www)   return `<a href="https://${www}" style="${LINK_STYLE}">${www}</a>`;
    if (bare)  return `<a href="https://${bare}" style="${LINK_STYLE}">${bare}</a>`;
    return m;
  });

  // 3. Split on double newlines → paragraphs
  const paragraphs = linked.split(/\n\n+/);

  // 4. Within each paragraph, single newlines → <br>
  const htmlParagraphs = paragraphs
    .map(para => {
      const withBreaks = para.trim().replace(/\n/g, '<br>');
      return `<p style="margin:0 0 14px 0;line-height:1.7;">${withBreaks}</p>`;
    })
    .filter(p => p !== '<p style="margin:0 0 14px 0;line-height:1.7;"></p>'); // drop empty

  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;">${htmlParagraphs.join('')}</div>`;
}

module.exports = { plainTextToHtml };
