import path from 'node:path';

const MAINNET_ACK = 'I_UNDERSTAND_VERUS_ARCADE_MAINNET_RISK';

function parsePositiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOrigin(value, network) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('ARCADE_ORIGIN must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('ARCADE_ORIGIN must use http or https');
  }
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('ARCADE_ORIGIN must not contain credentials, query, or fragment');
  }
  if (network === 'vrsc' && origin.protocol !== 'https:') {
    throw new Error('VRSC mainnet requires an HTTPS ARCADE_ORIGIN');
  }
  return origin.toString().replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const network = (env.ARCADE_NETWORK ?? 'vrsctest').trim().toLowerCase();
  if (!['vrsctest', 'vrsc'].includes(network)) {
    throw new Error('ARCADE_NETWORK must be exactly vrsctest or vrsc');
  }

  if (env.ARCADE_CHAINS && env.ARCADE_CHAINS.trim() !== network) {
    throw new Error(
      'ARCADE_CHAINS is deprecated; configure one chain with ARCADE_NETWORK',
    );
  }

  const isMainnet = network === 'vrsc';
  if (
    isMainnet &&
    (env.NODE_ENV !== 'production' || env.ARCADE_MAINNET_ACK !== MAINNET_ACK)
  ) {
    throw new Error(
      'VRSC mainnet requires NODE_ENV=production and the exact ARCADE_MAINNET_ACK',
    );
  }

  const appData = env.APPDATA ?? '';
  const defaultConf =
    network === 'vrsctest'
      ? path.join(appData, 'Komodo', 'vrsctest', 'vrsctest.conf')
      : path.join(appData, 'Komodo', 'VRSC', 'VRSC.conf');
  const confPath =
    env.ARCADE_CONF ??
    (network === 'vrsctest'
      ? env.ARCADE_VRSCTEST_CONF
      : env.ARCADE_VRSC_CONF) ??
    defaultConf;

  const defaultOrigin = 'http://127.0.0.1:8100';
  const origin = parseOrigin(env.ARCADE_ORIGIN ?? defaultOrigin, network);
  const sessionTtlSeconds = parsePositiveInteger(
    'ARCADE_SESSION_TTL_SECONDS',
    env.ARCADE_SESSION_TTL_SECONDS,
    12 * 60 * 60,
  );

  return Object.freeze({
    environment: env.NODE_ENV ?? 'development',
    network,
    isMainnet,
    origin,
    arcadeIdentity: env.ARCADE_ID ?? 'Arcade@',
    confPath,
    sessionTtlSeconds,
    authPort: parsePositiveInteger(
      'ARCADE_AUTH_PORT',
      env.ARCADE_AUTH_PORT,
      8100,
    ),
    productionPort: parsePositiveInteger('PORT', env.PORT, 3003),
    debug: env.ARCADE_DEBUG === '1',
    legacyPublisherEnabled: false,
  });
}

export { MAINNET_ACK };
