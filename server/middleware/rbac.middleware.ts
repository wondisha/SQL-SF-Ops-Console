import { Request, Response, NextFunction } from 'express';

export type AppPermission =
  | 'diagnostics:read'
  | 'diagnostics:execute'
  | 'sessions:terminate'
  | 'connections:manage'
  | 'secrets:rotate'
  | 'audit:export';

const ROLE_PERMISSIONS: Record<string, AppPermission[]> = {
  Viewer: ['diagnostics:read'],
  Operator: ['diagnostics:read', 'diagnostics:execute', 'sessions:terminate'],
  Admin: [
    'diagnostics:read',
    'diagnostics:execute',
    'sessions:terminate',
    'connections:manage',
    'secrets:rotate',
    'audit:export'
  ]
};

export function requirePermission(...requiredPermissions: AppPermission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const userRoles = req.user.roles || [];
    const userPermissions = new Set<AppPermission>();

    userRoles.forEach(role => {
      const perms = ROLE_PERMISSIONS[role] || [];
      perms.forEach(p => userPermissions.add(p));
    });

    const hasAllRequired = requiredPermissions.every(p => userPermissions.has(p));

    if (!hasAllRequired) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Insufficient privileges',
        required: requiredPermissions
      });
      return;
    }

    next();
  };
}
