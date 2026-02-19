/**
 * contentExtractor.js
 *
 * Shared text extraction utilities used by ALL storage provider implementations.
 * Lives here so OneDriveProvider and GoogleDriveProvider don't duplicate this logic.
 *
 * Handles: .txt, .vtt, .docx, .pdf, .eml, .msg, Google Docs exports
 */

const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

// Max file size to attempt content extraction (10MB)
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Canonical MIME type → category mapping.
 * Used by all providers to classify files consistently.
 * Google native MIME types are included here too.
 */
const MIME_CATEGORY_MAP = {
  // Plain text / transcripts
  'text/plain':                          'transcript',
  'text/vtt':                            'transcript',

  // Documents
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/pdf':                     'document',
  'application/msword':                  'document',

  // Google native formats (exported to docx/pdf before extraction)
  'application/vnd.google-apps.document':     'document',
  'application/vnd.google-apps.presentation': 'document',
  'application/vnd.google-apps.spreadsheet':  'document',

  // Email
  'message/rfc822':                      'email',
  'application/vnd.ms-outlook':          'email',
};

/**
 * Resolve the category for a given MIME type.
 * @param {string} mimeType
 * @returns {'transcript'|'document'|'email'|'unknown'}
 */
function resolveCategory(mimeType) {
  return MIME_CATEGORY_MAP[mimeType] || 'document';
}

/**
 * Check whether a file size is within the processing limit.
 * Throws a descriptive error if too large.
 * @param {number} sizeBytes
 * @param {string} fileName
 */
function assertSizeAllowed(sizeBytes, fileName) {
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File "${fileName}" is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB — exceeds the 10MB processing limit.`
    );
  }
}

/**
 * Extract plain text from a raw file buffer.
 * This is the core extraction function shared by all providers.
 *
 * @param {Buffer} buffer       - Raw file bytes
 * @param {string} mimeType     - File MIME type
 * @param {string} fileName     - Used for error messages
 * @returns {Promise<string>}   - Extracted plain text
 */
async function extractTextFromBuffer(buffer, mimeType, fileName) {
  switch (mimeType) {
    case 'text/plain':
    case 'text/vtt':
      return cleanVttText(buffer.toString('utf-8'));

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      const docxResult = await mammoth.extractRawText({ buffer });
      return docxResult.value;

    case 'application/pdf':
      const pdfResult = await pdfParse(buffer);
      return pdfResult.text;

    case 'message/rfc822':
    case 'application/vnd.ms-outlook':
      return extractEmailBody(buffer.toString('utf-8'));

    default:
      // Attempt UTF-8 fallback for unknown text-like files
      const text = buffer.toString('utf-8');
      if (text && text.length > 0 && isPrintableText(text)) return text;
      throw new Error(`Unsupported file type: ${mimeType} (${fileName})`);
  }
}

/**
 * Strip WebVTT timing cues, leaving only speaker text.
 * Input:  "WEBVTT\n\n1\n00:01.000 --> 00:04.000\nJohn: Hello\n\n"
 * Output: "John: Hello"
 */
function cleanVttText(raw) {
  return raw
    .split('\n')
    .filter((line) => {
      if (line.trim() === 'WEBVTT') return false;
      if (/^\d+$/.test(line.trim())) return false;  // cue sequence numbers
      if (/-->/.test(line)) return false;            // timestamp lines
      if (line.trim() === '') return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Extract body text from a raw .eml string.
 * Strips MIME headers; returns first text/plain body part.
 */
function extractEmailBody(raw) {
  const headerEnd = raw.indexOf('\n\n');
  if (headerEnd === -1) return raw;
  return raw.slice(headerEnd + 2).trim();
}

/**
 * Heuristic: is this buffer likely human-readable text?
 * Used as a fallback for unrecognized MIME types.
 */
function isPrintableText(str) {
  const sample = str.slice(0, 500);
  const nonPrintable = sample.split('').filter((c) => {
    const code = c.charCodeAt(0);
    return code < 9 || (code > 13 && code < 32);
  });
  return nonPrintable.length / sample.length < 0.1;
}

module.exports = {
  MIME_CATEGORY_MAP,
  resolveCategory,
  assertSizeAllowed,
  extractTextFromBuffer,
  cleanVttText,
  MAX_FILE_SIZE_BYTES,
};
