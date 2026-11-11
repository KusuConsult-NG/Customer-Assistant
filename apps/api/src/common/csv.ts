/**
 * A small, strict CSV reader (RFC 4180: quoted fields, doubled quotes, CRLF).
 *
 * Strict on purpose: a budget import that silently shifts a column turns a
 * programme code into an amount. A row with the wrong number of fields is
 * reported with its line number rather than padded or truncated.
 */
export interface CsvTable {
  header: string[];
  rows: Array<{ line: number; values: Record<string, string> }>;
  errors: Array<{ line: number; message: string }>;
}

export function parseCsv(text: string, maxRows = 20000): CsvTable {
  const records: Array<{ line: number; fields: string[] }> = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStart = 1;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\r') {
      /* handled with \n */
    } else if (c === '\n') {
      fields.push(field);
      records.push({ line: recordStart, fields });
      fields = [];
      field = '';
      line++;
      recordStart = line;
    } else field += c;
  }
  if (field !== '' || fields.length) {
    fields.push(field);
    records.push({ line: recordStart, fields });
  }

  const nonEmpty = records.filter((r) => r.fields.some((f) => f.trim() !== ''));
  const header = (nonEmpty.shift()?.fields ?? []).map((h) => h.trim());
  const errors: CsvTable['errors'] = [];
  const rows: CsvTable['rows'] = [];
  for (const r of nonEmpty.slice(0, maxRows)) {
    if (r.fields.length !== header.length) {
      errors.push({ line: r.line, message: `Expected ${header.length} columns, found ${r.fields.length}.` });
      continue;
    }
    rows.push({ line: r.line, values: Object.fromEntries(header.map((h, i) => [h, r.fields[i].trim()])) });
  }
  if (nonEmpty.length > maxRows) errors.push({ line: 0, message: `Only the first ${maxRows} rows were read.` });
  return { header, rows, errors };
}
