const dns = require('dns');
const mongoose = require('mongoose');
const { env } = require('../config/env');
const { URL } = require('url');

const MONGODB_SRV_PREFIX = 'mongodb+srv://';
const FALLBACK_DNS_SERVERS = ['8.8.8.8', '8.8.4.4'];

async function resolveSrvRecords(hostname) {
  try {
    return await dns.promises.resolveSrv(`_mongodb._tcp.${hostname}`);
  } catch (resolveError) {
    if (['ECONNREFUSED', 'ENODATA', 'ENOTFOUND'].includes(resolveError.code)) {
      dns.setServers(FALLBACK_DNS_SERVERS);
      return await dns.promises.resolveSrv(`_mongodb._tcp.${hostname}`);
    }

    throw resolveError;
  }
}

async function buildFallbackUriFromSrv(uri) {
  const parsed = new URL(uri);
  const hostname = parsed.hostname;
  const username = parsed.username;
  const password = parsed.password;
  const database = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.slice(1) : '';

  const records = await resolveSrvRecords(hostname);
  if (!records.length) {
    throw new Error(`No SRV records found for ${hostname}`);
  }

  const hosts = records.map((record) => `${record.name}:${record.port}`).join(',');
  const queryParams = new URLSearchParams(parsed.searchParams);

  if (!queryParams.has('retryWrites')) queryParams.set('retryWrites', 'true');
  if (!queryParams.has('w')) queryParams.set('w', 'majority');
  if (!queryParams.has('tls') && !queryParams.has('ssl')) queryParams.set('tls', 'true');

  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  const dbSegment = database ? `/${database}` : '';
  const queryString = queryParams.toString();

  return `mongodb://${auth}${hosts}${dbSegment}${queryString ? `?${queryString}` : ''}`;
}

const connectDB = async () => {
  const uri = env.mongoUri;
  const options = {
    serverSelectionTimeoutMS: 10000,
  };

  try {
    await mongoose.connect(uri, options);
    console.log('MongoDB connected');
    return true;
  } catch (firstError) {
    const isSrv = uri.toLowerCase().startsWith(MONGODB_SRV_PREFIX);
    const firstMessage = firstError.message || firstError;

    if (!isSrv || !firstMessage.includes('querySrv')) {
      console.error('MongoDB connection failed:', firstMessage);
      return false;
    }

    try {
      const fallbackUri = await buildFallbackUriFromSrv(uri);
      await mongoose.connect(fallbackUri, options);
      console.log('MongoDB connected');
      return true;
    } catch (fallbackError) {
      console.error('MongoDB connection failed:', fallbackError.message || fallbackError);
      return false;
    }
  }
};

module.exports = connectDB;
