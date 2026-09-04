const IS_DEMO_MODE = process.env.DEMO_MODE === 'true';
import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { writeAuditLog } from '../services/audit.service';

export interface EnterpriseUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  groups: string[];
  tenantId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: EnterpriseUser;
    }
  }
}

const TENANT_ID = process.env.ENTRA_TENANT_ID;
const ISSUER_URL = process.env.OIDC_ISSUER_URL || (TENANT_ID ? `https://login.microsoftonline.com/${TENANT_ID}/v2.0` : '');
const AUDIENCE = process.env.OIDC_CLIENT_ID;

if (!ISSUER_URL || !AUDIENCE) {
  console.warn('[AUTH_WARN] OIDC_ISSUER_URL or OIDC_CLIENT_ID is not configured. Real token verification will fail.');
}

const JWKS = ISSUER_URL ? createRemoteJWKSet(new URL(`${ISSUER_URL}/discovery/v2.0/keys`)) : null;

export async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Whitelist public health endpoints
  if (req.path === '/health' || req.path === '/api/health') {
    return next();
  }

  // 2. Mock authentication when running in simulation/demo mode
  if (IS_DEMO_MODE) {
    req.user = {
      id: 'demo-user-id',
      email: 'demo-evaluator@omnidb.local',
      name: 'OmniDB Demo Evaluator',
      roles: ['Admin', 'diagnostics:read'],
      groups: ['DemoUsers'],
      tenantId: 'demo-sandbox'
    };
    return next();
  }
  const token = req.cookies?.session_token || req.headers.authorization?.replace(/^Bearer\s+/, '');

  if (!token) {
    writeAuditLog({
      timestamp: new Date().toISOString(),
      user: { id: 'anonymous', email: 'unauthenticated', tenantId: 'none' },
      clientIp: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      serverId: (req.query.server as string) || 'none',
      database: (req.query.database as string) || 'none',
      queryId: req.path,
      durationMs: 0,
      status: 'ERROR',
      errorMessage: 'UNAUTHORIZED: Authentication token missing'
    });

    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }

  if (!JWKS || !ISSUER_URL) {
    writeAuditLog({
      timestamp: new Date().toISOString(),
      user: { id: 'anonymous', email: 'unauthenticated', tenantId: 'none' },
      clientIp: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      serverId: (req.query.server as string) || 'none',
      database: (req.query.database as string) || 'none',
      queryId: req.path,
      durationMs: 0,
      status: 'ERROR',
      errorMessage: 'CONFIG_ERROR: Identity provider keys not initialized'
    });

    res.status(500).json({ error: 'CONFIG_ERROR', message: 'Identity provider keys not initialized' });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER_URL,
      audience: AUDIENCE,
    });

    req.user = {
      id: (payload.oid as string) || (payload.sub as string),
      email: (payload.preferred_username as string) || (payload.email as string) || '',
      name: (payload.name as string) || 'Enterprise User',
      roles: (payload.roles as string[]) || [],
      groups: (payload.groups as string[]) || [],
      tenantId: (payload.tid as string) || '',
    };

    next();
  } catch (err: any) {
    writeAuditLog({
      timestamp: new Date().toISOString(),
      user: { id: 'invalid-token', email: 'unauthenticated', tenantId: 'none' },
      clientIp: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      serverId: (req.query.server as string) || 'none',
      database: (req.query.database as string) || 'none',
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

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.roles.includes(role)) {
      writeAuditLog({
        timestamp: new Date().toISOString(),
        user: {
          id: req.user?.id || 'unidentified',
          email: req.user?.email || 'unidentified',
          tenantId: req.user?.tenantId || 'none'
        },
        clientIp: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
        serverId: (req.query.server as string) || 'none',
        database: (req.query.database as string) || 'none',
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

