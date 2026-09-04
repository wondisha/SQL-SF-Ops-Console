"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enterpriseSnowflakeConfig = exports.enterpriseSqlConfig = void 0;
const enterpriseSqlConfig = (dbPassword) => ({
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
            minVersion: 'TLSv1.3'
        },
        connectTimeout: 10000,
        requestTimeout: 15000,
        rowCollectionOnRequestCompletion: false
    }
});
exports.enterpriseSqlConfig = enterpriseSqlConfig;
const enterpriseSnowflakeConfig = (privateKeyPem) => ({
    account: process.env.SNOWFLAKE_ACCOUNT || '',
    username: process.env.SNOWFLAKE_SVC_USER || '',
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: privateKeyPem,
    clientSessionKeepAlive: false,
    timeout: 15000
});
exports.enterpriseSnowflakeConfig = enterpriseSnowflakeConfig;
