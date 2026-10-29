// Fail-closed guard for harnesses that issue destructive statements (TRUNCATE).
//
// The only target the destructive fixtures may ever touch is the exact local
// disposable staging database below. Anything else — different host, port or
// database, URL query parameters that could redirect the connection, or
// libpq environment variables that override the validated parts — is refused
// before a single mutation runs. There is no name-pattern matching: a database
// called "contest" or "latest" is not accepted by substring luck.
//
// This module never logs or throws the URL itself, only its non-secret parts.

const ALLOWED_TARGET = Object.freeze({
  host: '127.0.0.1',
  port: '55433',
  database: 'nimbir_workspace_staging',
});

// libpq lets these environment variables override parts of a connection
// string, so a validated URL is not the whole story. Values equal to the
// allowlisted target are tolerated; anything else (including PGOPTIONS,
// PGSERVICE and friends, which have no safe value here) is refused.
const ENV_OVERRIDES = {
  PGHOST: 'host',
  PGPORT: 'port',
  PGDATABASE: 'database',
};

// These can silently redirect or reconfigure a connection regardless of the
// URL, so any value at all is refused.
const ENV_UNCONDITIONAL_REJECT = ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGREQUIRESSL', 'PGTARGETSESSIONATTRS'];

function describe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('refusing to run: a connection URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`refusing to run: unsupported protocol ${parsed.protocol}`);
  }
  if (parsed.search) {
    // pg-connection-string maps query parameters (including host/port) into the
    // effective configuration, so any query string is a redirect risk.
    throw new Error('refusing to run: connection URL carries query parameters');
  }
  let database;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('refusing to run: database name is not valid percent-encoding');
  }
  return { host: parsed.hostname.toLowerCase(), port: parsed.port || '5432', database };
}

// harness: must be exactly true (the caller checks NIMBIR_SYNTHETIC_HARNESS
// itself; passing a boolean keeps this module free of process.env reads so
// unit tests stay deterministic).
export function assertSyntheticTarget({ harness, runtimeUrl, ownerUrl }) {
  if (harness !== true) {
    throw new Error('refusing to run: NIMBIR_SYNTHETIC_HARNESS=1 is not set');
  }
  const targets = { DATABASE_URL: runtimeUrl, SEED_DATABASE_URL: ownerUrl };
  for (const [name, url] of Object.entries(targets)) {
    if (!url) throw new Error(`refusing to run: ${name} is not set`);
    const target = describe(url);
    if (target.host !== ALLOWED_TARGET.host) {
      throw new Error(`refusing to run: ${name} host ${target.host} is not the allowlisted local harness host`);
    }
    if (target.port !== ALLOWED_TARGET.port) {
      throw new Error(`refusing to run: ${name} port ${target.port} is not the allowlisted local harness port`);
    }
    if (target.database !== ALLOWED_TARGET.database) {
      throw new Error(`refusing to run: ${name} database "${target.database}" is not the exact allowlisted disposable staging database`);
    }
  }
  for (const name of ENV_UNCONDITIONAL_REJECT) {
    if (process.env[name] !== undefined) {
      throw new Error(`refusing to run: ${name} is set and can override the validated connection target`);
    }
  }
  for (const [name, key] of Object.entries(ENV_OVERRIDES)) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (value !== ALLOWED_TARGET[key]) {
      throw new Error(`refusing to run: ${name} is set to a value other than the allowlisted target`);
    }
  }
  return ALLOWED_TARGET.database;
}
