"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateToken = authenticateToken;
exports.requireRole = requireRole;
const jose_1 = require("jose");
const audit_service_1 = require("../services/audit.service");
const TENANT_ID = process.env.ENTRA_TENANT_ID;
const ISSUER_URL = process.env.OIDC_ISSUER_URL || (TENANT_ID ? `https://login.microsoftonline.com/${TENANT_ID}/v2.0` : '');
const AUDIENCE = process.env.OIDC_CLIENT_ID;
if (!ISSUER_URL || !AUDIENCE) {
    console.warn('[AUTH_WARN] OIDC_ISSUER_URL or OIDC_CLIENT_ID is not configured. Real token verification will fail.');
}
const JWKS = ISSUER_URL ? (0, jose_1.createRemoteJWKSet)(new URL(`${ISSUER_URL}/discovery/v2.0/keys`)) : null;
async function authenticateToken(req, res, next) {
    const token = req.cookies?.session_token || req.headers.authorization?.replace(/^Bearer\s+/, '');
    if (!token) {
        (0, audit_service_1.writeAuditLog)({
            timestamp: new Date().toISOString(),
            user: { id: 'anonymous', email: 'unauthenticated', tenantId: 'none' },
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
            serverId: req.query.server || 'none',
            database: req.query.database || 'none',
            queryId: req.path,
            durationMs: 0,
            status: 'ERROR',
            errorMessage: 'UNAUTHORIZED: Authentication token missing'
        });
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
    }
    if (!JWKS || !ISSUER_URL) {
        (0, audit_service_1.writeAuditLog)({
            timestamp: new Date().toISOString(),
            user: { id: 'anonymous', email: 'unauthenticated', tenantId: 'none' },
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
            serverId: req.query.server || 'none',
            database: req.query.database || 'none',
            queryId: req.path,
            durationMs: 0,
            status: 'ERROR',
            errorMessage: 'CONFIG_ERROR: Identity provider keys not initialized'
        });
        res.status(500).json({ error: 'CONFIG_ERROR', message: 'Identity provider keys not initialized' });
        return;
    }
    try {
        const { payload } = await (0, jose_1.jwtVerify)(token, JWKS, {
            issuer: ISSUER_URL,
            audience: AUDIENCE,
        });
        req.user = {
            id: payload.oid || payload.sub,
            email: payload.preferred_username || payload.email || '',
            name: payload.name || 'Enterprise User',
            roles: payload.roles || [],
            groups: payload.groups || [],
            tenantId: payload.tid || '',
        };
        next();
    }
    catch (err) {
        (0, audit_service_1.writeAuditLog)({
            timestamp: new Date().toISOString(),
            user: { id: 'invalid-token', email: 'unauthenticated', tenantId: 'none' },
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
            serverId: req.query.server || 'none',
            database: req.query.database || 'none',
            queryId: req.path,
            durationMs: 0,
            status: 'ERROR',
            errorMessage: `UNAUTHORIZED: ${err.message || 'Token verification failed'}`
        });
        res.status(401).json({
            error: 'UNAUTHORIZED',
            message: 'Token verification failed or expired',
            code: err.code || 'ERR_JWT_INVALID',
        });
    }
}
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || !req.user.roles.includes(role)) {
            (0, audit_service_1.writeAuditLog)({
                timestamp: new Date().toISOString(),
                user: {
                    id: req.user?.id || 'unidentified',
                    email: req.user?.email || 'unidentified',
                    tenantId: req.user?.tenantId || 'none'
                },
                clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
                serverId: req.query.server || 'none',
                database: req.query.database || 'none',
                queryId: req.path,
                durationMs: 0,
                status: 'ERROR',
                errorMessage: `FORBIDDEN: Missing required role '${role}'`
            });
            res.status(403).json({ error: 'FORBIDDEN', message: `Required role '${role}' missing` });
            return;
        }
        next();
    };
}
