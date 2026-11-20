import { readRegular, sanitizeUnityText } from './protocol.js';
import type { UnityReport } from '@devhub/contracts';

const xmlLimit = 4 * 1024 ** 2;

function xmlText(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '');
}

function attr(node: string, name: string) {
  const result = new RegExp('(?:^|\\s)' + name + '=(?:"([^"]*)"|\'([^\']*)\')').exec(node);
  return result?.[1] ?? result?.[2];
}

export function parseUnityTests(xml: string): NonNullable<UnityReport['tests']> {
  if (Buffer.byteLength(xml) > xmlLimit || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<\/test-run>\s*$/.test(xml)) {
    throw new Error('UNITY_TEST_XML_INVALID');
  }
  const header = /<test-run\b([^>]*)>/.exec(xml)?.[1];
  if (!header) throw new Error('UNITY_TEST_XML_INVALID');
  const integer = (name: string) => {
    const raw = attr(header, name);
    if (!raw || !/^\d{1,8}$/.test(raw)) throw new Error('UNITY_TEST_XML_INVALID');
    return Number(raw);
  };
  const total = integer('total');
  const passed = integer('passed');
  const failed = integer('failed');
  const skipped = integer('skipped') + integer('inconclusive');
  if (total !== passed + failed + skipped) throw new Error('UNITY_TEST_XML_INVALID');
  const names = [...xml.matchAll(/<test-case\b([^>]*)>/g)].filter((token) => attr(token[1]!, 'result') === 'Failed')
    .slice(0, 50).map((token) => sanitizeUnityText(xmlText(attr(token[1]!, 'fullname') ?? attr(token[1]!, 'name') ?? 'Test')).slice(0, 240));
  const failures = [...xml.matchAll(/<test-case\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-case>)/g)]
    .filter((token) => attr(token[1]!, 'result') === 'Failed' && token[2]).slice(0, 50).map((token) => {
      const body = /<message>([\s\S]*?)<\/message>/.exec(token[2]!)?.[1] ?? '';
      const message = body.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '');
      return { name: sanitizeUnityText(xmlText(attr(token[1]!, 'fullname') ?? 'Test')).slice(0, 240),
        message: sanitizeUnityText(xmlText(message)).trim().slice(0, 500) };
    });
  return { total, passed, failed, skipped, names, ...(failures.length ? { failures } : {}) };
}

export async function readUnityTests(raw: string, project: string) {
  const text = sanitizeUnityText((await readRegular(raw, xmlLimit)).toString('utf8'), project);
  return { text, tests: parseUnityTests(text) };
}

export function unityDiagnostics(text: string): UnityReport['diagnostics'] {
  const results: UnityReport['diagnostics'] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^(.+\.cs)\((\d+)(?:,\d+)?\):\s*(error|warning)\s+(CS\d+):\s*(.*)$/i.exec(line.trim());
    if (match) {
      const [, file, number, severity, code, message] = match;
      const cleaned = file!.replaceAll('\\', '/').replace(/^<worktree>\//, '');
      results.push({ severity: severity!.toLowerCase() === 'warning' ? 'warning' : 'error', code: code!.toUpperCase(),
        file: /^(?:Assets|Packages)\//.test(cleaned) && !cleaned.split('/').includes('..') ? cleaned.slice(0, 280) : null,
        line: Number(number), message: message!.slice(0, 1000) });
    } else if (/no valid unity editor license|unity has not been activated|IPC channel to LicensingClient doesn't exist; aborting/i.test(line)) {
      results.push({ severity: 'error', code: 'UNITY_LICENSE_UNAVAILABLE', file: null, line: null, message: 'Unity license unavailable.' });
    } else if (/(?:failed to import|error importing|asset import failed)/i.test(line)) {
      results.push({ severity: 'error', code: 'UNITY_ASSET_IMPORT_FAILED', file: null, line: null, message: line.slice(0, 1000) });
    } else if (/^\[Package Manager\].*(?:failed|timed? out|error)/i.test(line)) {
      results.push({ severity: 'warning', code: 'UNITY_PACKAGE_MANAGER', file: null, line: null, message: line.slice(0, 1000) });
    }
    if (results.length >= 100) break;
  }
  return results.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
