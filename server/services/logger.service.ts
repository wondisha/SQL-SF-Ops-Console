import winston from 'winston';

const SENSITIVE_PATTERNS = [
  /password\s*=\s*['"]?[^'";\s]+['"]?/gi,
  /secret\s*=\s*['"]?[^'";\s]+['"]?/gi,
  /bearer\s+[a-zA-Z0-9_\-\.]+/gi,
  /pwd\s*=\s*['"]?[^'";\s]+['"]?/gi,
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, // Credit Card / PAN
  /\b\d{3}-\d{2}-\d{4}\b/g                     // SSN
];

export function sanitizeLogData(input: any): any {
  if (typeof input === 'string') {
    let sanitized = input;
    SENSITIVE_PATTERNS.forEach(pattern => {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    });
    return sanitized;
  }
  if (Array.isArray(input)) {
    return input.map(item => sanitizeLogData(item));
  }
  if (input !== null && typeof input === 'object') {
    const output: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (/password|secret|token|credential|key/i.test(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = sanitizeLogData(value);
      }
    }
    return output;
  }
  return input;
}

const redactFormat = winston.format((info) => {
  return sanitizeLogData(info);
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    redactFormat(),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'sql-sf-ops-console',
    environment: process.env.NODE_ENV || 'production'
  },
  transports: [
    new winston.transports.Console()
  ]
});
