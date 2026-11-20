function quoteCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Export untrusted text as a literal cell in spreadsheet applications. */
export function csvText(value: string): string {
  const formula = /^[\t\r\n]/.test(value) || /^[=+\-@＝＋－＠]/u.test(value.trimStart());
  return quoteCsv(formula ? `'${value}` : value);
}
