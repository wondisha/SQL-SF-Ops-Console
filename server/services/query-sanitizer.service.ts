export function sanitizeRowData(rows: any[]): any[] {
  if (!Array.isArray(rows)) return rows;

  return rows.map((row) => {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string') {
        // Mask Windows and POSIX absolute file paths
        let cleanVal = value.replace(/([a-zA-Z]:\\[^:\n\r"']+\.[a-zA-Z0-9]+)/g, '[INTERNAL_SCRIPT_PATH]');
        cleanVal = cleanVal.replace(/(\/(?:var|etc|usr|home|opt)\/[^\s"']+)/g, '[INTERNAL_FILE_PATH]');

        // Mask internal Windows service accounts
        cleanVal = cleanVal.replace(/NT Service\\[a-zA-Z0-9_$]+/gi, 'SVC_ACCOUNT');
        sanitized[key] = cleanVal;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  });
}
