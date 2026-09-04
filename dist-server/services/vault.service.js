"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.vaultService = void 0;
const keyvault_secrets_1 = require("@azure/keyvault-secrets");
const identity_1 = require("@azure/identity");
class SecretVaultService {
    client = null;
    cache = new Map();
    CACHE_TTL_MS = 15 * 60 * 1000;
    constructor() {
        const vaultUrl = process.env.AZURE_KEYVAULT_URL;
        if (vaultUrl) {
            const credential = new identity_1.DefaultAzureCredential();
            this.client = new keyvault_secrets_1.SecretClient(vaultUrl, credential);
        }
    }
    async getSecret(secretName) {
        const now = Date.now();
        const cached = this.cache.get(secretName);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }
        if (!this.client) {
            const localEnvValue = process.env[secretName.toUpperCase().replace(/-/g, '_')];
            if (localEnvValue)
                return localEnvValue;
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
        }
        catch (err) {
            this.cache.delete(secretName);
            throw new Error(`Vault retrieval failed for ${secretName}: ${err.message}`);
        }
    }
    invalidateCache(secretName) {
        if (secretName) {
            this.cache.delete(secretName);
        }
        else {
            this.cache.clear();
        }
    }
}
exports.vaultService = new SecretVaultService();
