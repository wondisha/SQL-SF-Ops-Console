"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.sanitizeLogData = sanitizeLogData;
const winston_1 = __importDefault(require("winston"));
const SENSITIVE_PATTERNS = [
    /password\s*=\s*['"]?[^'";\s]+['"]?/gi,
    /secret\s*=\s*['"]?[^'";\s]+['"]?/gi,
    /bearer\s+[a-zA-Z0-9_\-\.]+/gi,
    /pwd\s*=\s*['"]?[^'";\s]+['"]?/gi,
    /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, // Credit Card / PAN
    /\b\d{3}-\d{2}-\d{4}\b/g // SSN
];
function sanitizeLogData(input) {
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
        const output = {};
        for (const [key, value] of Object.entries(input)) {
            if (/password|secret|token|credential|key/i.test(key)) {
                output[key] = '[REDACTED]';
            }
            else {
                output[key] = sanitizeLogData(value);
            }
        }
        return output;
    }
    return input;
}
const redactFormat = winston_1.default.format((info) => {
    return sanitizeLogData(info);
});
exports.logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }), redactFormat(), winston_1.default.format.json()),
    defaultMeta: {
        service: 'sql-sf-ops-console',
        environment: process.env.NODE_ENV || 'production'
    },
    transports: [
        new winston_1.default.transports.Console()
    ]
});
