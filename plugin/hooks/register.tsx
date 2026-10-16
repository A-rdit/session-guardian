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

const WRAPUP_SAVE =
  "Save the state. If CLAUDE.md has session or tracker rules, follow them. Otherwise update TRACKER.md at the project root (create it if it is missing): where this session stopped, what comes next, and anything that waits on me."
const WRAPUP_DEAD_ENDS =
  'Dead ends. These commands failed again and again in this session. Add one line each to the notes you just saved, under "Dead ends": what failed and what worked instead, so the next session skips them. A lasting fact about this project (the right way to run its tests, a tool that is not installed here) goes in its CLAUDE.md as one line instead. Correct the "seen working" hint if it is wrong, drop any that no longer matter, and leave out secrets.'
const WRAPUP_TITLE = 'If you can rename this session, put ✓ in front of its title when the work is done, or @ when something waits on me.'
const WRAPUP_REPLY = 'Reply in at most three short lines: what is saved and where, and a one-line prompt I can paste to start the next session.'

/** Sessions smaller than this are not worth an automatic save. */
const AUTOSAVE_MIN_TOKENS = 20_000
/** The latest an automatic save may come, so it always lands while the cache is still warm. */
const AUTOSAVE_MAX_MS = 58 * 60_000

/** The most dead ends /wrapup lists, and how much of a command or error line it quotes. */
const MAX_DEAD_ENDS = 8
const MAX_QUOTE = 160

const RETRY_HELD =
  `${PLUGIN} paused this command: it has failed twice in a row, unchanged, with no edit in between. ` +
  'Running it a third time the same way will most likely fail again. Fix the cause or try a different approach first, ' +
  'or explain to the user what is in the way. Sending the identical command again will run it.'

/** Tools whose success means something changed, so a failed command may be worth retrying. */
const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** The session's notes, by file name: TRACKER.md, SESSIONS.md, any *HANDOVER*.md. */
const NOTES_FILE = /^(tracker|sessions)(-archive)?\.md$|handover[^\\/]*\.md$/i
/** A shell command that names a notes file is working on the notes, as a script that adds a SESSIONS.md row does. */
const NOTES_NAMED = /\b(tracker|sessions)(-archive)?\.md\b|handover[\w.-]*\.md\b/i
/** Tools that only keep the session's own books (its title, plan and sidebar markers) and change nothing worth saving. */
const BOOKKEEPING = /^(mcp__ccd_|ToolSearch$|TodoWrite$|Task(Create|Update|List|Get)$)/

const isNotesFile = (path: string) => NOTES_FILE.test(path.split(/[\\/]/).at(-1) ?? '')

/** Settings, read from the manifest's userConfig when the module loads. */
const cfg = { warnMs: 5 * 60_000, warnFrom: 150_000, wrapupAt: 400_000, weeklyUsd: 0, retryGuard: true, deadEnds: true, autoSaveMs: 50 * 60_000 }

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
  /** A turn is running; set when a prompt goes in, cleared when the main turn completes. */
  busy: false,
  /** Something was asked since the last save, so there is something to save. */
  dirty: false,
  autosaving: false,
  /** When the last automatic save finished; null once something new is asked. */
  savedAt: null as number | null,
  /** The running turn has written the session's notes and done nothing since but keep its books. */
  notesLast: false,
}

/** Failed commands per loop, for the retry guard. */
const fails = new Map<string, number>()
const waived = new Set<string>()

/** A command that failed twice in a row unchanged. Kept through edits and compaction until /wrapup saves it. */
type DeadEnd = { loop: string; tool: string; command: string; fails: number; error: string; worked?: string }
const deadEnds = new Map<string, DeadEnd>()

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
  s.dirty = false
  s.autosaving = false
  s.savedAt = null
  s.notesLast = false
}

const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const quote = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_QUOTE ? `${line.slice(0, MAX_QUOTE - 1)}…` : line
}

/** The line of a failed command's output that says what went wrong: the first that names an error, else the last. */
function errorLine(text: string | undefined): string {
  const lines = (text ?? '').split('\n').map(l => l.trim()).filter(l => l && !/^exit code \d+$/i.test(l))
  const named = lines.find(l => /error|not found|not recognized|cannot|denied|failed|no such/i.test(l))
  return quote(named ?? lines.at(-1) ?? '')
}

/** The program a command runs, past any leading `cd somewhere &&`: `npm` for `cd app && npm test`. */
const program = (command: string) =>
  command.replace(/^(\s*(cd|Set-Location|pushd)\s+[^;&|]+(&&|;)\s*)+/i, '').trim().split(/\s+/)[0]!.toLowerCase()

/** Counts a failure; a command that fails twice in a row unchanged becomes a dead end. */
function deadEndFailed(key: string, loop: string, tool: string, command: string, inARow: number, text: string | undefined) {
  const known = deadEnds.get(key)
  if (known) {
    known.fails += 1
    known.error = errorLine(text) || known.error
    known.worked = undefined
  } else if (inARow >= 2 && deadEnds.size < MAX_DEAD_ENDS) {
    deadEnds.set(key, { loop, tool, command, fails: inARow, error: errorLine(text) })
  }
}

/** A command that succeeds after a dead end in the same loop, running the same program, is likely what worked. */
function deadEndPassed(loop: string, command: string) {
  for (const dead of deadEnds.values()) {
    if (dead.loop === loop && dead.worked === undefined && program(dead.command) === program(command)) {
      dead.worked = command
    }
  }
}

function wrapupPrompt(): string {
  const steps = [WRAPUP_SAVE]
  if (cfg.deadEnds && deadEnds.size > 0) {
    const lines = [...deadEnds.values()].map(d => {
      const worked =
        d.worked === undefined
          ? 'Nothing seen working after it.'
          : d.worked === d.command
            ? 'Seen working later, unchanged, after something else changed.'
            : `Seen working after it: \`${quote(d.worked)}\`.`
      const error = d.error ? `: ${d.error}.` : '.'
      return `   - \`${quote(d.command)}\` (${d.tool}) failed ${d.fails} times${error} ${worked}`
    })
    steps.push([WRAPUP_DEAD_ENDS, ...lines].join('\n'))
  }
  steps.push(WRAPUP_TITLE, WRAPUP_REPLY)
  return [
    'Wrap up this session so a fresh session can pick up the work without this chat.',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
  ].join('\n')
}

function autosavePrompt(idleMs: number): string {
  return [
    `Autosave from ${PLUGIN}: this session has been quiet for ${minutes(idleMs)}, and its cache goes cold in about ${minutes(CACHE_MS - idleMs)}.`,
    WRAPUP_SAVE,
    'Write each item that waits on me in plain words: what it is, what it holds up, and where to look.',
    'Do not start new work and do not mark the session done. If nothing changed since the last save, change nothing.',
    "Reply in one line: what you saved and where, or 'Nothing new to save.'",
  ].join(' ')
}

/** Before the cache goes cold, asks a quiet session that did something since its last save to save where it stopped. */
function maybeAutosave($: EngineInterface, now: number) {
  if (cfg.autoSaveMs <= 0 || !s.dirty || s.busy || s.autosaving || s.wrapping || s.wrapped) return
  if (s.lastMainAt === null || s.tokens < AUTOSAVE_MIN_TOKENS) return
  const idle = now - s.lastMainAt
  if (idle < cfg.autoSaveMs || idle >= CACHE_MS) return
  s.autosaving = true
  void $.prompt.submit({ text: autosavePrompt(idle), asUser: true })
}

/** Works out the band, and the one pop-up before the cache goes cold. */
async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  maybeAutosave($, now)
  let next: Band | null = null

  if (s.wrapped) {
    next = {
      tone: 'saved',
      text: 'Wrapped up and saved. Safe to archive; start the next session from its notes.',
    }
  } else if (s.savedAt !== null && !s.dirty) {
    const cold = s.lastMainAt !== null && now - s.lastMainAt >= CACHE_MS
    next = {
      tone: 'saved',
      text: cold
        ? `Saved automatically at ${clockTime(s.savedAt)}, and the cache has gone cold since. A fresh session that reads the notes is cheaper than a message here.`
        : `Saved automatically at ${clockTime(s.savedAt)}. Coming back after a break? A fresh session can pick up from the notes.`,
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
  void $.prompt.submit({ text: wrapupPrompt(), asUser: true })
}

export const register: Register = (on, options) => {
  cfg.warnMs = num(options.warnMinutes, 5) * 60_000
  cfg.warnFrom = num(options.warnFromTokens, 150_000)
  cfg.wrapupAt = num(options.wrapupAt, 400_000) || 400_000
  cfg.weeklyUsd = num(options.weeklyUsd, 0)
  cfg.retryGuard = options.retryGuard !== false
  cfg.deadEnds = options.deadEnds !== false
  cfg.autoSaveMs = Math.min(num(options.autoSaveMinutes, 50) * 60_000, AUTOSAVE_MAX_MS)

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
      s.dirty = true
      s.savedAt = null
    }
    s.busy = true
    s.notesLast = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    s.busy = false
    if (s.wrapping && !e.isAborted) {
      s.wrapping = false
      s.wrapped = true
      s.dirty = false
      // Saved with the notes; a fresh list starts here.
      deadEnds.clear()
    }
    if (s.autosaving) {
      s.autosaving = false
      // A stopped save is not retried: whoever stopped it is at the keyboard.
      s.dirty = false
      if (!e.isAborted) s.savedAt = await $.clock.now()
    }
    // The turn ended on writing the session's notes: an autosave would only reword them.
    if (s.notesLast && !e.isAborted) s.dirty = false
    s.notesLast = false
    await refresh($)
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
      deadEnds.clear()
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
        deadEndPassed(loop, command!)
      } else if (ran.deny === undefined) {
        const inARow = (fails.get(key) ?? 0) + 1
        fails.set(key, inARow)
        deadEndFailed(key, loop, String(e.tool), command!, inARow, ran.text)
      }
    }
    if (ok && MUTATING.has(String(e.tool))) {
      fails.clear()
      waived.clear()
    }
    if (e.agentId === undefined) {
      const file = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'Read' ? e.file_path : null
      if (file !== null && isNotesFile(file)) {
        if (ok && e.tool !== 'Read') s.notesLast = true
      } else if (!(command !== null && NOTES_NAMED.test(command)) && !BOOKKEEPING.test(String(e.tool))) {
        // Anything else the turn does after its notes may be news the notes lack.
        s.notesLast = false
      }
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
