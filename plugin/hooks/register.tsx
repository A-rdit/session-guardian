import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band } from '../types'

const PLUGIN = 'session-guardian'
const band = atom({ plugin: 'session-guardian', key: 'band' } as const, null as Band | null)

/** The main conversation's cache lives an hour after its last request (subscription). */
const CACHE_MS = 60 * 60_000
/** The band starts counting down this long before the cache goes cold. */
const COUNTDOWN_MS = 15 * 60_000
const TICK_MS = 60_000

/**
 * [model id pattern, input $/M, cache read $/M], Anthropic list prices of October 2026.
 * A 1-hour cache write costs 2x input; a warm message re-reads at the cache read price.
 */
const PRICES: readonly [RegExp, number, number][] = [
  [/fable-5-1|mythos-5-1/, 10, 0.25],
  [/fable|mythos/, 10, 1],
  [/opus-5-5/, 4, 0.2],
  [/opus-[45]/, 5, 0.5],
  [/sonnet-5/, 2, 0.2],
  [/sonnet-4/, 3, 0.3],
  [/haiku/, 1, 0.1],
]
const OPUS = PRICES[2]!

const WRAPUP = [
  'Wrap up this session so a fresh session can pick up the work without this chat.',
  "1. Save the state. If CLAUDE.md has session or tracker rules, follow them. Otherwise update TRACKER.md at the project root (create it if it is missing): where this session stopped, what comes next, and anything that waits on me.",
  '2. If you can rename this session, put ✓ in front of its title when the work is done, or @ when something waits on me.',
  '3. Reply in at most three short lines: what is saved and where, and a one-line prompt I can paste to start the next session.',
].join('\n')

const RETRY_HELD =
  `${PLUGIN} paused this command: it has failed twice in a row, unchanged, with no edit in between. ` +
  'Running it a third time the same way will most likely fail again. Fix the cause or try a different approach first, ' +
  'or explain to the user what is in the way. Sending the identical command again will run it.'

/** Tools whose success means something changed, so a failed command may be worth retrying. */
const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** Settings, read from the manifest's userConfig when the module loads. */
const cfg = { warnMs: 5 * 60_000, warnFrom: 150_000, wrapupAt: 400_000, weeklyUsd: 0, retryGuard: true }

/** The main conversation, as this mod has seen it since it loaded. */
const s = {
  model: 'claude-opus-5-5',
  tokens: 0,
  lastMainAt: null as number | null,
  warnedFor: null as number | null,
  nudged: 0,
  wrapping: false,
  wrapped: false,
  ticking: false,
}

/** Failed commands per loop, for the retry guard. */
const fails = new Map<string, number>()
const waived = new Set<string>()

const num = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 ? v : fallback)
const k = (tokens: number) => `${Math.round(tokens / 1000)}K`
const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} min`

/** What re-writing `tokens` into a cold cache costs, in ordinary messages and, if set, the week. */
function rewriteCost(tokens: number): string {
  const [, input, cacheRead] = PRICES.find(([re]) => re.test(s.model)) ?? OPUS
  const messages = Math.round((input * 2) / cacheRead)
  let text = `as much as about ${messages} ordinary messages here`
  if (cfg.weeklyUsd > 0) {
    const pct = ((tokens * input * 2) / 1e6 / cfg.weeklyUsd) * 100
    text += pct < 0.1 ? ', under 0.1% of your week' : `, about ${pct.toFixed(1)}% of your week`
  }
  return text
}

function forget() {
  s.lastMainAt = null
  s.warnedFor = null
  s.nudged = 0
  s.wrapping = false
  s.wrapped = false
}

/** Works out the band, and the one pop-up before the cache goes cold. */
async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  let next: Band | null = null

  if (s.wrapped) {
    next = {
      tone: 'saved',
      text: 'Wrapped up and saved. Safe to archive; start the next session from its notes.',
    }
  } else if (s.lastMainAt !== null && s.tokens >= cfg.warnFrom) {
    const left = s.lastMainAt + CACHE_MS - now
    if (left <= 0) {
      next = {
        tone: 'cold',
        text: `Cache expired. Your next message here rewrites ${k(s.tokens)}, ${rewriteCost(s.tokens)}. If this session is saved, a fresh one is cheaper.`,
      }
    } else if (left <= COUNTDOWN_MS) {
      next = {
        tone: 'warm',
        text: `Cache warm ${minutes(left)} more. After that the next message rewrites ${k(s.tokens)}, ${rewriteCost(s.tokens)}. Leaving? /wrapup first.`,
      }
      if (left <= cfg.warnMs && s.warnedFor !== s.lastMainAt) {
        s.warnedFor = s.lastMainAt
        $.ui.toast(
          `This session goes cold in ${minutes(left)}. Coming back after that rewrites ${k(s.tokens)}, ${rewriteCost(s.tokens)}. Back soon: send a short message. Done for now: /wrapup.`,
          { timeoutMs: 60_000 },
        )
      }
    }
  }

  if (next === null && !s.wrapped && s.tokens >= cfg.wrapupAt) {
    next = {
      tone: 'big',
      text: `${k(s.tokens)} in this session: every message re-reads all of it. Good point to /wrapup and start fresh.`,
    }
  }

  await update($, band, () => next)
}

/** One nudge at the wrap-up size, one more at twice it. */
function nudge($: EngineInterface) {
  const level = s.tokens >= cfg.wrapupAt * 2 ? 2 : s.tokens >= cfg.wrapupAt ? 1 : 0
  if (level > s.nudged && !s.wrapped) {
    s.nudged = level
    $.ui.toast(
      `This session holds ${k(s.tokens)}. Each message re-reads all of it. Good point to /wrapup and start a fresh session.`,
      { timeoutMs: 30_000 },
    )
  }
}

function submitWrapup($: EngineInterface) {
  void $.prompt.submit({ text: WRAPUP, asUser: true })
}

export const register: Register = (on, options) => {
  cfg.warnMs = num(options.warnMinutes, 5) * 60_000
  cfg.warnFrom = num(options.warnFromTokens, 150_000)
  cfg.wrapupAt = num(options.wrapupAt, 400_000) || 400_000
  cfg.weeklyUsd = num(options.weeklyUsd, 0)
  cfg.retryGuard = options.retryGuard !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wrapup',
      description: 'Save where this session stopped so a fresh one can pick up, then mark it done',
    })
    const usage = await $.session.usage()
    s.tokens = usage.context.tokens ?? 0
    if (!s.ticking) {
      s.ticking = true
      $.clock.every(TICK_MS, () => void refresh($))
    }
    await refresh($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    s.tokens = e.context.tokens ?? s.tokens
    nudge($)
    await refresh($)
    return next(e)
  })

  // Each main-thread request refreshes the cache; subagents have caches of their own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      s.model = e.model
      s.lastMainAt = await $.clock.now()
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const fromUs = e.origin.kind === 'plugin' && e.origin.name === PLUGIN
    if (!fromUs) {
      s.wrapping = false
      s.wrapped = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && s.wrapping && !e.isAborted) {
      s.wrapping = false
      s.wrapped = true
      await refresh($)
    }
    return result
  })

  on('command.run', { command: 'wrapup' }, async $ => {
    s.wrapping = true
    $.clock.after(0, () => submitWrapup($))
    return { text: 'Wrapping up: saving where this session stopped.' }
  })

  on('session.compact', async ($, e, next) => {
    forget()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      forget()
      s.tokens = 0
      await refresh($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? 'main'
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command.trim() : null
    const key = command === null ? null : `${loop}\u0000${e.tool}\u0000${command}`

    if (cfg.retryGuard && key !== null && (fails.get(key) ?? 0) >= 2 && !waived.has(key)) {
      waived.add(key)
      $.ui.log(`Paused a third try of \`${command!.slice(0, 80)}\`: it failed twice in a row, unchanged.`)
      return { deny: RETRY_HELD }
    }

    const ran = await next(e)
    const ok = ran.deny === undefined && ran.isError !== true
    if (key !== null) {
      if (ok) {
        fails.delete(key)
        waived.delete(key)
      } else if (ran.deny === undefined) {
        fails.set(key, (fails.get(key) ?? 0) + 1)
      }
    }
    if (ok && MUTATING.has(String(e.tool))) {
      fails.clear()
      waived.clear()
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, band)
    if (shown === null || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const color =
      shown.tone === 'cold' ? 'red' : shown.tone === 'warm' ? 'yellow' : shown.tone === 'saved' ? 'green' : undefined

    return (
      <Box>
        <Text color={color} dimColor={color === undefined} wrap="wrap">
          {shown.text}
        </Text>
      </Box>
    )
  })
}
