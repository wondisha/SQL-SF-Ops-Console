"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirePermission = requirePermission;
const ROLE_PERMISSIONS = {
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
function requirePermission(...requiredPermissions) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return;
        }
        const userRoles = req.user.roles || [];
        const userPermissions = new Set();
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
