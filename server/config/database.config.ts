export const enterpriseSqlConfig = (dbPassword: string) => ({
  server: process.env.DB_SERVER_FQDN || 'localhost',
  authentication: {
    type: 'default',
    options: {
      userName: process.env.DB_USER || 'sa',
      password: dbPassword
    }
  },
  options: {
    encrypt: true,
    trustServerCertificate: false,
    cryptoCredentialsDetails: {
      minVersion: 'TLSv1.3' as const
    },
    connectTimeout: 10000,
    requestTimeout: 15000,
    rowCollectionOnRequestCompletion: false
  }
});

export const enterpriseSnowflakeConfig = (privateKeyPem: string) => ({
  account: process.env.SNOWFLAKE_ACCOUNT || '',
  username: process.env.SNOWFLAKE_SVC_USER || '',
  authenticator: 'SNOWFLAKE_JWT',
  privateKey: privateKeyPem,
  clientSessionKeepAlive: false,
  timeout: 15000
});
