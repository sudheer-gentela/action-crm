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
 *   - http/https URLs       → clickable <a> links
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

  // 2. Convert bare URLs to clickable links
  const linked = escaped.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" style="color:#1a6fc4;text-decoration:none;">$1</a>'
  );

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
