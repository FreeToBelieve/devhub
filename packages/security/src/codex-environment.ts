const allowed = [
  'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'LOCALAPPDATA', 'APPDATA',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
];

export function codexEnvironment(
  source: NodeJS.ProcessEnv, codexHome: string, explicitProviderProxy: string | null = null,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.includes(key.toUpperCase())) environment[key] = value;
  }
  environment.CODEX_HOME = codexHome;
  // The SDK's provider HTTP client may use an explicitly configured local proxy.
  // Shell tools inherit none of this environment and keep tool networking disabled.
  if (explicitProviderProxy) {
    environment.HTTP_PROXY = explicitProviderProxy;
    environment.HTTPS_PROXY = explicitProviderProxy;
  }
  return environment;
}
