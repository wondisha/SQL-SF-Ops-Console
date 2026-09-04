import { Request, Response, NextFunction } from "express";

const IS_DEMO_MODE = process.env.DEMO_MODE === "true";

export interface AuthenticatedUser {
  sub: string;
  id?: string;
  email?: string;
  name?: string;
  roles?: string[];
  permissions?: string[];
  [key: string]: any;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  if (IS_DEMO_MODE) {
    req.user = {
      sub: "demo-analyst@omnidb.local",
      id: "demo-analyst",
      email: "demo-analyst@omnidb.local",
      name: "Demo DBRE Analyst",
      roles: ["DBRE", "FinOpsAuditor"],
      permissions: ["diagnostics:read", "finops:read"]
    };
    return next();
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Missing Bearer token." });
  }

  return next();
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (IS_DEMO_MODE) {
      return next();
    }

    const user = req.user;
    if (!user || (!user.permissions?.includes(permission) && !user.roles?.includes("DBRE"))) {
      return res.status(403).json({ error: "FORBIDDEN", message: `Missing required permission: ${permission}` });
    }

    return next();
  };
}

export default { authenticateToken, requirePermission };
