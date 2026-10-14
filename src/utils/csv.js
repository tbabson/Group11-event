// Escapes a value for CSV and neutralises spreadsheet formula injection.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvRow = (values) => values.map(csvCell).join(',');

export { csvCell, csvRow };
export default { csvCell, csvRow };
