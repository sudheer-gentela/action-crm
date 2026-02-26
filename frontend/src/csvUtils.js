/**
 * CSV Utilities — Export & Import helpers for Action CRM
 *
 * csvExport:  Takes an array of objects + column config → triggers .csv download
 * csvParse:   Takes a CSV string → returns { headers, rows }
 */

// ── CSV Export ─────────────────────────────────────────────────────────────────

/**
 * @param {Object[]} data        — array of row objects
 * @param {Object[]} columns     — [{ key, label, format? }]
 *   key:    dot-path into row (e.g. 'account.name', 'value')
 *   label:  header label in the CSV
 *   format: optional (val, row) => string formatter
 * @param {string}   filename    — e.g. 'deals-export.csv'
 */
export function csvExport(data, columns, filename) {
  if (!data || data.length === 0) {
    alert('No data to export.');
    return;
  }

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    // Wrap in quotes if the value contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const headerRow = columns.map(c => escape(c.label)).join(',');

  const bodyRows = data.map(row => {
    return columns.map(col => {
      let val = resolvePath(row, col.key);
      if (col.format) val = col.format(val, row);
      return escape(val);
    }).join(',');
  });

  const csv = [headerRow, ...bodyRows].join('\n');
  downloadBlob(csv, filename, 'text/csv;charset=utf-8;');
}

function resolvePath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

function downloadBlob(content, filename, mimeType) {
  const BOM = '\uFEFF'; // UTF-8 BOM so Excel handles unicode
  const blob = new Blob([BOM + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}


// ── CSV Parse (for Import) ─────────────────────────────────────────────────────

/**
 * Parses a CSV string into headers + rows.
 * Handles quoted fields, commas inside quotes, escaped quotes ("").
 *
 * @param {string} text  — raw CSV content
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function csvParse(text) {
  const lines = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field.trim());
        field = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        current.push(field.trim());
        if (current.some(f => f !== '')) lines.push(current);
        current = [];
        field = '';
        if (ch === '\r') i++; // skip \n in \r\n
      } else {
        field += ch;
      }
    }
  }

  // Last field / last line
  current.push(field.trim());
  if (current.some(f => f !== '')) lines.push(current);

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0];
  const rows = lines.slice(1);
  return { headers, rows };
}


// ── Column configs for each entity ─────────────────────────────────────────────

export const EXPORT_COLUMNS = {

  deals: [
    { key: 'name',                label: 'Deal Name' },
    { key: 'value',               label: 'Value', format: v => v != null ? String(v) : '' },
    { key: 'stage',               label: 'Stage' },
    { key: 'health',              label: 'Health' },
    { key: 'probability',         label: 'Probability (%)' },
    { key: 'expected_close_date', label: 'Expected Close Date', format: v => v ? new Date(v).toLocaleDateString() : '' },
    { key: 'account.name',        label: 'Account' },
    { key: 'owner.first_name',    label: 'Owner First Name' },
    { key: 'owner.last_name',     label: 'Owner Last Name' },
    { key: 'notes',               label: 'Notes' },
    { key: 'created_at',          label: 'Created', format: v => v ? new Date(v).toLocaleDateString() : '' },
  ],

  accounts: [
    { key: 'name',        label: 'Account Name' },
    { key: 'domain',      label: 'Domain' },
    { key: 'industry',    label: 'Industry' },
    { key: 'size',        label: 'Size' },
    { key: 'location',    label: 'Location' },
    { key: 'description', label: 'Description' },
    { key: 'created_at',  label: 'Created', format: v => v ? new Date(v).toLocaleDateString() : '' },
  ],

  contacts: [
    { key: 'first_name',       label: 'First Name' },
    { key: 'last_name',        label: 'Last Name' },
    { key: 'email',            label: 'Email' },
    { key: 'phone',            label: 'Phone' },
    { key: 'title',            label: 'Job Title' },
    { key: 'role_type',        label: 'Role Type' },
    { key: 'engagement_level', label: 'Engagement Level' },
    { key: 'location',         label: 'Location' },
    { key: 'linkedin_url',     label: 'LinkedIn URL' },
    { key: 'notes',            label: 'Notes' },
    { key: 'account.name',     label: 'Account', format: (v, row) => v || row?.account_name || '' },
    { key: 'created_at',       label: 'Created', format: v => v ? new Date(v).toLocaleDateString() : '' },
  ],

  actions: [
    { key: 'title',       label: 'Title' },
    { key: 'type',        label: 'Type' },
    { key: 'actionType',  label: 'Action Type' },
    { key: 'priority',    label: 'Priority' },
    { key: 'status',      label: 'Status' },
    { key: 'nextStep',    label: 'Next Step' },
    { key: 'isInternal',  label: 'Internal?', format: v => v ? 'Yes' : 'No' },
    { key: 'dueDate',     label: 'Due Date', format: v => v ? new Date(v).toLocaleDateString() : '' },
    { key: 'deal.name',   label: 'Deal' },
    { key: 'deal.stage',  label: 'Deal Stage' },
    { key: 'deal.account',label: 'Account' },
    { key: 'description', label: 'Description' },
    { key: 'suggestedAction', label: 'Suggested Action' },
    { key: 'createdAt',   label: 'Created', format: v => v ? new Date(v).toLocaleDateString() : '' },
  ],
};


// ── Import field configs ───────────────────────────────────────────────────────

export const IMPORT_FIELDS = {

  accounts: [
    { key: 'name',        label: 'Account Name', required: true },
    { key: 'domain',      label: 'Domain' },
    { key: 'industry',    label: 'Industry' },
    { key: 'size',        label: 'Size' },
    { key: 'location',    label: 'Location' },
    { key: 'description', label: 'Description' },
  ],

  contacts: [
    { key: 'firstName',   label: 'First Name',  required: true },
    { key: 'lastName',    label: 'Last Name',   required: true },
    { key: 'email',       label: 'Email',       required: true },
    { key: 'phone',       label: 'Phone' },
    { key: 'title',       label: 'Job Title' },
    { key: 'roleType',    label: 'Role Type' },
    { key: 'location',    label: 'Location' },
    { key: 'linkedinUrl', label: 'LinkedIn URL' },
    { key: 'notes',       label: 'Notes' },
    { key: 'accountId',   label: 'Account ID (or name to match)' },
  ],

  deals: [
    { key: 'name',              label: 'Deal Name',           required: true },
    { key: 'value',             label: 'Value',               required: true },
    { key: 'stage',             label: 'Stage' },
    { key: 'health',            label: 'Health' },
    { key: 'expectedCloseDate', label: 'Expected Close Date' },
    { key: 'probability',       label: 'Probability (%)' },
    { key: 'notes',             label: 'Notes' },
    { key: 'accountId',         label: 'Account ID (or name to match)' },
  ],
};
