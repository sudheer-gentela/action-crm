/**
 * contentExtractor.js
 * Shared text extraction utilities used by all storage providers.
 * Handles: .txt, .vtt, .docx, .pdf, .eml, .msg, Google Docs exports
 */

const mammoth  = require('mammoth');
const pdfParse = require('pdf-parse');

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const MIME_CATEGORY_MAP = {
  'text/plain':                          'transcript',
  'text/vtt':                            'transcript',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/pdf':                     'document',
  'application/msword':                  'document',
  'application/vnd.google-apps.document':     'document',
  'application/vnd.google-apps.presentation': 'document',
  'application/vnd.google-apps.spreadsheet':  'document',
  'message/rfc822':                      'email',
  'application/vnd.ms-outlook':          'email',
};

function resolveCategory(mimeType) {
  return MIME_CATEGORY_MAP[mimeType] || 'document';
}

function assertSizeAllowed(sizeBytes, fileName) {
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File "${fileName}" is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB — exceeds the 10MB limit.`
    );
  }
}

async function extractTextFromBuffer(buffer, mimeType, fileName) {
  switch (mimeType) {
    case 'text/plain':
    case 'text/vtt':
      return cleanVttText(buffer.toString('utf-8'));

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword': {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    case 'application/pdf': {
      const result = await pdfParse(buffer);
      return result.text;
    }

    case 'message/rfc822':
    case 'application/vnd.ms-outlook':
      return extractEmailBody(buffer.toString('utf-8'));

    default: {
      const text = buffer.toString('utf-8');
      if (text && text.length > 0 && isPrintableText(text)) return text;
      throw new Error(`Unsupported file type: ${mimeType} (${fileName})`);
    }
  }
}

function cleanVttText(raw) {
  return raw
    .split('\n')
    .filter((line) => {
      if (line.trim() === 'WEBVTT') return false;
      if (/^\d+$/.test(line.trim())) return false;
      if (/-->/.test(line)) return false;
      if (line.trim() === '') return false;
      return true;
    })
    .join('\n')
    .trim();
}

function extractEmailBody(raw) {
  const headerEnd = raw.indexOf('\n\n');
  if (headerEnd === -1) return raw;
  return raw.slice(headerEnd + 2).trim();
}

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
  MAX_FILE_SIZE_BYTES,
};
