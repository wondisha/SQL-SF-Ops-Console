import fs from 'fs';
import path from 'path';

export interface AuditEntry {
  timestamp: string;
  user: {
    id: string;
    email: string;
    tenantId: string;
  };
  clientIp: string;
  serverId: string;
  database: string;
  queryId: string;
  durationMs: number;
  status: 'SUCCESS' | 'ERROR';
  rowsReturned?: number;
  errorMessage?: string;
}

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const AUDIT_LOG_FILE = path.join(LOG_DIR, 'audit.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function writeAuditLog(entry: AuditEntry): void {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(AUDIT_LOG_FILE, line, { encoding: 'utf8' }, (err) => {
    if (err) {
      console.error('[AUDIT_FATAL] Failed to write to audit.log:', err.message);
    }
  });
}
