import type { Response } from 'express';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed with an apostrophe
 * (CSV injection); plain numbers, negative ones included, are left as numbers.
 */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(','), ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/** Sends a CSV download. The byte-order mark makes Excel read the file as UTF-8 (₦, accents). */
export function sendCsv<T>(res: Response, filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\uFEFF${toCsv(columns, rows)}`);
}
