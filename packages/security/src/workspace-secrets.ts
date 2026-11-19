// Keep template names out of the native blanket deny rules.
const template = /\.(?:example|sample|template|dist)$/i;
const secretName = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|(?:application_default_)?credentials(?:\.(?:json|ya?ml|toml))?|secrets?\.(?:json|ya?ml|toml))$/i;
const secretExtension = /\.(?:env|pem|key|p12|pfx|jks|kdbx)$/i;

export function isWorkspaceSecretPath(path: string) {
  const parts = path.toLowerCase().split('/');
  const filename = parts.at(-1) ?? '';
  if (parts.some((entry) => entry === '.ssh' || entry === '.aws' || entry === '.gnupg')) return true;
  if (template.test(filename)) return false;
  return secretExtension.test(filename) || (filename !== '.npmrc' && secretName.test(filename));
}

export function isSensitiveConfig(path: string) {
  const name = path.toLowerCase().split('/').at(-1) ?? '';
  return name === '.npmrc' || template.test(name);
}

const privateKeyHeader = /^[ \t]*-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[ \t\r]*$/m;
const gitProviderSecret = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/;
const npmAuth = /(?:^|:)\s*(?:_authToken|_auth|_password|username|password|token|keyfile|certfile)\s*=/i;
const sensitiveAssignment = /^\s*(?:export\s+)?["']?[\w.-]*(?:token|password|secret|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*(.*)$/i;

function reference(value: string) {
  const clean = value.trim().replace(/,$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  return clean === '' || /^(?:\$\{[A-Z_][A-Z0-9_]*\}|<[^<>]+>|changeme|your[_-][a-z0-9_-]+|example(?:[_-][a-z0-9_-]+)?|placeholder)$/i.test(clean);
}

export function containsWorkspaceSecret(text: string, inspectAssignments = false, strictNpmrc = false) {
  if (privateKeyHeader.test(text) || gitProviderSecret.test(text)) return true;
  if (!inspectAssignments) return false;
  return text.split(/\r?\n/).some((line) => {
    if (/^\s*[#;]/.test(line)) return false;
    if (strictNpmrc && /https?:\/\/[^/\s:@]+(?::[^/\s@]*)?@/i.test(line)) return true;
    if (npmAuth.test(line)) return strictNpmrc || !reference(line.slice(line.indexOf('=') + 1));
    const value = sensitiveAssignment.exec(line)?.[1];
    return value !== undefined && !reference(value);
  });
}

const nativePatterns = [
  '.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local',
  '.env.test', '.env.test.local', '.env.staging', '.npmrc', '.netrc', '.git-credentials', '.pypirc',
  '.ssh', '.ssh/**', '.aws', '.aws/**', '.gnupg', '.gnupg/**', 'credentials.json', 'credentials.yaml', 'credentials.yml',
  'application_default_credentials.json', 'secrets.json', 'secrets.yaml', 'secret.json', 'secret.yaml',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.kdbx',
];

export const workspaceSecretRules = Object.freeze(nativePatterns.flatMap((name) => [name, '**/' + name]));
