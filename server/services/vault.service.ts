import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

class SecretVaultService {
  private client: SecretClient | null = null;
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000;

  constructor() {
    const vaultUrl = process.env.AZURE_KEYVAULT_URL;
    if (vaultUrl) {
      const credential = new DefaultAzureCredential();
      this.client = new SecretClient(vaultUrl, credential);
    }
  }

  async getSecret(secretName: string): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(secretName);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    if (!this.client) {
      const localEnvValue = process.env[secretName.toUpperCase().replace(/-/g, '_')];
      if (localEnvValue) return localEnvValue;
      throw new Error(`Vault client unconfigured and secret '${secretName}' not found in environment`);
    }

    try {
      const secret = await this.client.getSecret(secretName);
      if (!secret.value) {
        throw new Error(`Secret '${secretName}' returned an empty value`);
      }

      this.cache.set(secretName, {
        value: secret.value,
        expiresAt: now + this.CACHE_TTL_MS
      });

      return secret.value;
    } catch (err: any) {
      this.cache.delete(secretName);
      throw new Error(`Vault retrieval failed for ${secretName}: ${err.message}`);
    }
  }

  invalidateCache(secretName?: string): void {
    if (secretName) {
      this.cache.delete(secretName);
    } else {
      this.cache.clear();
    }
  }
}

export const vaultService = new SecretVaultService();
