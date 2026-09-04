"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = exports.CircuitState = void 0;
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
class CircuitBreaker {
    name;
    config;
    state = CircuitState.CLOSED;
    failureCount = 0;
    nextAttempt = Date.now();
    constructor(name, config = {
        failureThreshold: 5,
        cooldownPeriodMs: 30000,
        requestTimeoutMs: 15000
    }) {
        this.name = name;
        this.config = config;
    }
    getState() {
        if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttempt) {
            this.state = CircuitState.HALF_OPEN;
        }
        return this.state;
    }
    async execute(action) {
        const currentState = this.getState();
        if (currentState === CircuitState.OPEN) {
            const retryInSec = Math.ceil((this.nextAttempt - Date.now()) / 1000);
            throw new Error(`[CircuitBreaker:${this.name}] Circuit is OPEN. Fast-failing. Retry in ${retryInSec}s.`);
        }
        try {
            const result = await Promise.race([
                action(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`[CircuitBreaker:${this.name}] Operation timed out`)), this.config.requestTimeoutMs))
            ]);
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        this.failureCount = 0;
        this.state = CircuitState.CLOSED;
    }
    onFailure() {
        this.failureCount++;
        if (this.state === CircuitState.HALF_OPEN || this.failureCount >= this.config.failureThreshold) {
            this.state = CircuitState.OPEN;
            this.nextAttempt = Date.now() + this.config.cooldownPeriodMs;
            console.warn(`[CircuitBreaker:${this.name}] Circuit OPEN until ${new Date(this.nextAttempt).toISOString()}`);
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
