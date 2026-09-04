export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownPeriodMs: number;
  requestTimeoutMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private nextAttempt = Date.now();

  constructor(
    public readonly name: string,
    private readonly config: CircuitBreakerConfig = {
      failureThreshold: 5,
      cooldownPeriodMs: 30000,
      requestTimeoutMs: 15000
    }
  ) {}

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttempt) {
      this.state = CircuitState.HALF_OPEN;
    }
    return this.state;
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      const retryInSec = Math.ceil((this.nextAttempt - Date.now()) / 1000);
      throw new Error(`[CircuitBreaker:${this.name}] Circuit is OPEN. Fast-failing. Retry in ${retryInSec}s.`);
    }

    try {
      const result = await Promise.race([
        action(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`[CircuitBreaker:${this.name}] Operation timed out`)), this.config.requestTimeoutMs)
        )
      ]);

      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.state === CircuitState.HALF_OPEN || this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.config.cooldownPeriodMs;
      console.warn(`[CircuitBreaker:${this.name}] Circuit OPEN until ${new Date(this.nextAttempt).toISOString()}`);
    }
  }
}
