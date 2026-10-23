export function buildPatentArgs(env = process.env) {
  const args = [];
  if (env.PATENT_WEB_FAST === '1') args.push('--fast');
  if (env.PATENT_WEB_KEYWORD_ONLY === '1') args.push('--keyword-only');
  if (env.PATENT_WEB_SOURCES) args.push('--sources', env.PATENT_WEB_SOURCES);
  if (env.PATENT_WEB_EXCLUDE) args.push('--exclude', env.PATENT_WEB_EXCLUDE);
  return args;
}

export function terminalDimensions(searchParams) {
  const dimension = (key, fallback, maximum) => {
    const raw = searchParams.get(key);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value)
      ? Math.max(1, Math.min(maximum, Math.floor(value)))
      : fallback;
  };
  return {
    cols: dimension('cols', 100, 300),
    rows: dimension('rows', 36, 120),
  };
}

export function isSameOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

export function terminalFontSize(width, height) {
  if (width < 700 || height < 560) return 14;
  if (width < 980 || height < 700) return 16;
  return 18;
}

export function clipboardShortcut(event) {
  if (event.type !== 'keydown' || event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'c') return 'copy';
  if (key === 'v') return 'paste';
  if (key === 'a') return 'home';
  return null;
}
