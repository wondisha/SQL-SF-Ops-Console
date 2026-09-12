const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function request(port, pathName) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathName }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request timeout')));
  });
}

function startServer(port, demoMode) {
  const environment = { ...process.env, PORT: String(port), DEMO_MODE: demoMode ? 'true' : 'false' };
  delete environment.AUTH_JWKS_URL;
  delete environment.AUTH_ISSUER;
  delete environment.AUTH_AUDIENCE;

  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 10000;
    const poll = () => {
      request(port, '/api/servers').then(() => resolve({ child, output })).catch(() => {
        if (Date.now() >= deadline) {
          resolve({ child, output: `${output}\nServer did not become ready.` });
          return;
        }
        setTimeout(poll, 100);
      });
    };
    poll();
    child.once('error', reject);
  });
}

test('live API fails closed when OIDC is not configured', async () => {
  const { child, output } = await startServer(4031, false);
  try {
    const response = await request(4031, '/api/servers');
    assert.equal(response.status, 503, output);
    assert.match(response.body, /AUTHENTICATION_NOT_CONFIGURED/);
  } finally {
    child.kill();
  }
});

test('demo API remains accessible without OIDC configuration', async () => {
  const { child, output } = await startServer(4032, true);
  try {
    const response = await request(4032, '/api/servers');
    assert.equal(response.status, 200, output);
    assert.match(response.body, /sql-primary/);
  } finally {
    child.kill();
  }
});
