"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const uuid_1 = require("uuid");
const api_router_1 = __importDefault(require("./routes/api.router"));
const engine_router_1 = __importDefault(require("./routes/engine.router"));
const health_router_1 = __importDefault(require("./routes/health.router"));
const auth_middleware_1 = require("./middleware/auth.middleware");
const logger_service_1 = require("./services/logger.service");
const helmet_1 = __importDefault(require("helmet"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
// Request correlation and structured logging
app.use((req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
    res.setHeader('X-Correlation-ID', correlationId);
    const start = Date.now();
    res.on('finish', () => {
        logger_service_1.logger.info('HTTP_ACCESS', {
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
app.use((0, helmet_1.default)({
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
const publicPath = path_1.default.resolve(process.cwd(), 'public');
app.use(express_1.default.static(publicPath));
// 2. Health probe endpoint (unauthenticated)
app.use('/healthz', health_router_1.default);
// 3. Authenticated enterprise API endpoints
app.use('/api', auth_middleware_1.authenticateToken, api_router_1.default);
app.use('/api', auth_middleware_1.authenticateToken, engine_router_1.default);
// 4. SPA Fallback (strictly for non-API GET requests)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'NOT_FOUND', path: req.path });
        return;
    }
    res.sendFile(path_1.default.join(publicPath, 'index.html'));
});
app.listen(PORT, () => {
    logger_service_1.logger.info(`Enterprise Ops Server listening on port ${PORT}`);
});
exports.default = app;
