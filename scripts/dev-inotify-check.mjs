import fs from 'node:fs'

// Linux file-watch (inotify) limits that Turbopack/webpack watchers consume.
// These are advisory: low limits degrade watch reliability but must never
// abort the dev runtime. In containers the values are namespaced read-only
// (they are raised on the host), and when polling is enabled inotify watches
// are not used at all — so the check is skipped entirely in those cases.
const INOTIFY_PROC_DIR = '/proc/sys/fs/inotify'

const INOTIFY_LIMITS = [
  { key: 'max_user_watches', recommended: 524288 },
  { key: 'max_user_instances', recommended: 512 },
  { key: 'max_queued_events', recommended: 16384 },
]

function isTruthyFlag(value) {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function isFileWatchPollingEnabled(env = {}) {
  return isTruthyFlag(env.WATCHPACK_POLLING) || isTruthyFlag(env.CHOKIDAR_USEPOLLING)
}

export function readInotifyLimits(readFileSync = fs.readFileSync) {
  const limits = {}
  for (const { key } of INOTIFY_LIMITS) {
    try {
      const raw = readFileSync(`${INOTIFY_PROC_DIR}/${key}`, 'utf8')
      const parsed = Number.parseInt(String(raw).trim(), 10)
      limits[key] = Number.isFinite(parsed) ? parsed : null
    } catch {
      limits[key] = null
    }
  }
  return limits
}

export function evaluateInotifyPreflight({ platform, env = {}, limits } = {}) {
  if (platform !== 'linux') {
    return { skip: true, reason: 'not-linux', shortfalls: [], limits: {} }
  }
  if (isTruthyFlag(env.OM_SKIP_INOTIFY_CHECK)) {
    return { skip: true, reason: 'disabled', shortfalls: [], limits: {} }
  }
  if (isFileWatchPollingEnabled(env)) {
    return { skip: true, reason: 'polling', shortfalls: [], limits: {} }
  }

  const resolved = limits ?? {}
  const readable = INOTIFY_LIMITS.some(({ key }) => typeof resolved[key] === 'number')
  if (!readable) {
    return { skip: true, reason: 'unreadable', shortfalls: [], limits: resolved }
  }

  const shortfalls = INOTIFY_LIMITS
    .filter(({ key, recommended }) => typeof resolved[key] === 'number' && resolved[key] < recommended)
    .map(({ key, recommended }) => ({ key, current: resolved[key], recommended }))

  return { skip: false, reason: shortfalls.length ? 'low' : 'ok', shortfalls, limits: resolved }
}

export function formatInotifyWarning(evaluation) {
  if (!evaluation || evaluation.skip || evaluation.shortfalls.length === 0) return null

  const recommended = Object.fromEntries(INOTIFY_LIMITS.map(({ key, recommended }) => [key, recommended]))
  const shortfallLines = evaluation.shortfalls
    .map(({ key, current, recommended: rec }) => `  fs.inotify.${key}: ${current} < ${rec}`)
    .join('\n')
  const sysctlArgs = INOTIFY_LIMITS.map(({ key, recommended: rec }) => `fs.inotify.${key}=${rec}`).join(' ')
  const conf = INOTIFY_LIMITS.map(({ key, recommended: rec }) => `fs.inotify.${key}=${rec}`).join('\\n')

  return [
    '⚠️ Linux file-watch (inotify) limits are below the recommended values for Turbopack.',
    'Watchers still start, but on large trees you may see missed changes or watch errors.',
    '',
    shortfallLines,
    '',
    'To raise them on the host (containers inherit these from the host kernel):',
    `  sudo sysctl -w ${sysctlArgs}`,
    `  printf '# Open Mercato dev server file-watch limits\\n${conf}\\n' | sudo tee /etc/sysctl.d/99-open-mercato-inotify.conf >/dev/null`,
    '  sudo sysctl --system',
    '',
    'Already using CHOKIDAR_USEPOLLING/WATCHPACK_POLLING? This check is skipped in polling mode.',
    'Set OM_SKIP_INOTIFY_CHECK=1 to silence it.',
    `Current values: ${JSON.stringify(evaluation.limits)} (recommended: ${JSON.stringify(recommended)})`,
  ].join('\n')
}

export function checkFileWatchLimits({ env = process.env, platform = process.platform, log = console.warn, readFileSync } = {}) {
  const limits = platform === 'linux' && !isFileWatchPollingEnabled(env) && !isTruthyFlag(env.OM_SKIP_INOTIFY_CHECK)
    ? readInotifyLimits(readFileSync)
    : {}
  const evaluation = evaluateInotifyPreflight({ platform, env, limits })
  const warning = formatInotifyWarning(evaluation)
  if (warning) log(warning)
  return evaluation
}
