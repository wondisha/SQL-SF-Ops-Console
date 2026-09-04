"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAuditLog = writeAuditLog;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const LOG_DIR = path_1.default.resolve(process.cwd(), 'logs');
const AUDIT_LOG_FILE = path_1.default.join(LOG_DIR, 'audit.log');
if (!fs_1.default.existsSync(LOG_DIR)) {
    fs_1.default.mkdirSync(LOG_DIR, { recursive: true });
}
function writeAuditLog(entry) {
    const line = JSON.stringify(entry) + '\n';
    fs_1.default.appendFile(AUDIT_LOG_FILE, line, { encoding: 'utf8' }, (err) => {
        if (err) {
            console.error('[AUDIT_FATAL] Failed to write to audit.log:', err.message);
        }
    });
}
