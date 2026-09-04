import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import fs from 'fs';
import path from 'path';

async function generateLocalAuthKeys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'local-dev-key';
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  // Mint a mock Viewer Token
  const viewerToken = await new SignJWT({
    email: 'viewer@enterprise.internal',
    name: 'Ops Viewer',
    roles: ['Viewer'],
    groups: ['SG-Database-ReadOnly'],
    tid: 'local-dev-tenant'
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-dev-key' })
    .setIssuedAt()
    .setIssuer(process.env.OIDC_ISSUER_URL || 'https://login.microsoftonline.com/common/v2.0')
    .setAudience(process.env.OIDC_CLIENT_ID || 'ops-console-client')
    .setExpirationTime('2h')
    .sign(privateKey);

  // Mint a mock Admin Token
  const adminToken = await new SignJWT({
    email: 'admin@enterprise.internal',
    name: 'Principal DBA Admin',
    roles: ['Admin'],
    groups: ['SG-Database-Admins'],
    tid: 'local-dev-tenant'
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-dev-key' })
    .setIssuedAt()
    .setIssuer(process.env.OIDC_ISSUER_URL || 'https://login.microsoftonline.com/common/v2.0')
    .setAudience(process.env.OIDC_CLIENT_ID || 'ops-console-client')
    .setExpirationTime('2h')
    .sign(privateKey);

  console.log('\n=== MOCK VIEWER TOKEN ===\n', viewerToken);
  console.log('\n=== MOCK ADMIN TOKEN ===\n', adminToken);
}

generateLocalAuthKeys();
