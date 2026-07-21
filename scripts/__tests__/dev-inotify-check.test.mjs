import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isFileWatchPollingEnabled,
  readInotifyLimits,
  evaluateInotifyPreflight,
  formatInotifyWarning,
  checkFileWatchLimits,
} from '../dev-inotify-check.mjs'

const HEALTHY = { max_user_watches: 1048576, max_user_instances: 8192, max_queued_events: 65536 }
const LOW = { max_user_watches: 8192, max_user_instances: 128, max_queued_events: 16384 }

test('isFileWatchPollingEnabled: detects truthy polling flags case-insensitively', () => {
  assert.equal(isFileWatchPollingEnabled({ WATCHPACK_POLLING: 'true' }), true)
  assert.equal(isFileWatchPollingEnabled({ CHOKIDAR_USEPOLLING: '1' }), true)
  assert.equal(isFileWatchPollingEnabled({ WATCHPACK_POLLING: 'ON' }), true)
  assert.equal(isFileWatchPollingEnabled({ WATCHPACK_POLLING: 'false', CHOKIDAR_USEPOLLING: '0' }), false)
  assert.equal(isFileWatchPollingEnabled({}), false)
})

test('evaluateInotifyPreflight: skips on non-linux platforms', () => {
  const result = evaluateInotifyPreflight({ platform: 'darwin', env: {}, limits: LOW })
  assert.equal(result.skip, true)
  assert.equal(result.reason, 'not-linux')
})

test('evaluateInotifyPreflight: skips when polling is enabled', () => {
  const result = evaluateInotifyPreflight({ platform: 'linux', env: { WATCHPACK_POLLING: 'true' }, limits: LOW })
  assert.equal(result.skip, true)
  assert.equal(result.reason, 'polling')
})

test('evaluateInotifyPreflight: skips when explicitly disabled', () => {
  const result = evaluateInotifyPreflight({ platform: 'linux', env: { OM_SKIP_INOTIFY_CHECK: '1' }, limits: LOW })
  assert.equal(result.skip, true)
  assert.equal(result.reason, 'disabled')
})

test('evaluateInotifyPreflight: skips when limits are unreadable (non-linux host under emulation)', () => {
  const result = evaluateInotifyPreflight({ platform: 'linux', env: {}, limits: {} })
  assert.equal(result.skip, true)
  assert.equal(result.reason, 'unreadable')
})

test('evaluateInotifyPreflight: passes when limits meet the recommended minimums', () => {
  const result = evaluateInotifyPreflight({ platform: 'linux', env: {}, limits: HEALTHY })
  assert.equal(result.skip, false)
  assert.equal(result.reason, 'ok')
  assert.deepEqual(result.shortfalls, [])
})

test('evaluateInotifyPreflight: reports shortfalls when limits are low', () => {
  const result = evaluateInotifyPreflight({ platform: 'linux', env: {}, limits: LOW })
  assert.equal(result.skip, false)
  assert.equal(result.reason, 'low')
  assert.deepEqual(result.shortfalls.map((entry) => entry.key), ['max_user_watches', 'max_user_instances'])
})

test('formatInotifyWarning: returns null when nothing to warn about', () => {
  assert.equal(formatInotifyWarning({ skip: true, shortfalls: [], limits: {} }), null)
  assert.equal(formatInotifyWarning(evaluateInotifyPreflight({ platform: 'linux', env: {}, limits: HEALTHY })), null)
})

test('formatInotifyWarning: renders sysctl guidance for low limits', () => {
  const warning = formatInotifyWarning(evaluateInotifyPreflight({ platform: 'linux', env: {}, limits: LOW }))
  assert.match(warning, /inotify\) limits are below/)
  assert.match(warning, /fs\.inotify\.max_user_watches: 8192 < 524288/)
  assert.match(warning, /sudo sysctl -w fs\.inotify\.max_user_watches=524288/)
  assert.match(warning, /OM_SKIP_INOTIFY_CHECK=1/)
})

test('readInotifyLimits: parses proc values and tolerates read failures', () => {
  const readFileSync = (filePath) => {
    if (filePath.endsWith('max_user_watches')) return '1048576\n'
    if (filePath.endsWith('max_user_instances')) return '  512 '
    throw new Error('ENOENT')
  }
  assert.deepEqual(readInotifyLimits(readFileSync), {
    max_user_watches: 1048576,
    max_user_instances: 512,
    max_queued_events: null,
  })
})

test('checkFileWatchLimits: never reads proc or logs in polling mode', () => {
  const logged = []
  let reads = 0
  const evaluation = checkFileWatchLimits({
    platform: 'linux',
    env: { WATCHPACK_POLLING: 'true' },
    log: (message) => logged.push(message),
    readFileSync: () => { reads += 1; return '8192' },
  })
  assert.equal(evaluation.reason, 'polling')
  assert.equal(reads, 0)
  assert.equal(logged.length, 0)
})

test('checkFileWatchLimits: warns without throwing on low limits', () => {
  const logged = []
  const evaluation = checkFileWatchLimits({
    platform: 'linux',
    env: {},
    log: (message) => logged.push(message),
    readFileSync: (filePath) => (filePath.endsWith('max_user_watches') ? '8192' : '128'),
  })
  assert.equal(evaluation.reason, 'low')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /inotify/)
})
