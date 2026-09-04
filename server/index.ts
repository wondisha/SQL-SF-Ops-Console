import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import apiRouter from './routes/api.router';
import engineRouter from './routes/engine.router';
import healthRouter from './routes/health.router';
import { authenticateToken } from './middleware/auth.middleware';
import { logger } from './services/logger.service';
import helmet from 'helmet';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cookieParser());

// Request correlation and structured logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
  res.setHeader('X-Correlation-ID', correlationId);

  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP_ACCESS', {
      correlationId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      clientIp: req.ip
    });
  });

  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    }
  }
}));

// 1. Static asset directory
const publicPath = path.resolve(process.cwd(), 'public');
app.use(express.static(publicPath));

// 2. Health probe endpoint (unauthenticated)
app.use('/healthz', healthRouter);

// 3. Authenticated enterprise API endpoints
app.use('/api', authenticateToken, apiRouter);
app.use('/api', authenticateToken, engineRouter);

// 4. SPA Fallback (strictly for non-API GET requests)
app.get('*', (req: Request, res: Response) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'NOT_FOUND', path: req.path });
    return;
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
  logger.info(`Enterprise Ops Server listening on port ${PORT}`);
});

export default app;
