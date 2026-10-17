import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The engine beneath the plugin: answers what it calls, and records toasts and prompts. */
function engine(on: On, tokens = 0) {
  const seen = { toasts: [] as string[], logs: [] as string[], prompts: [] as string[], commands: [] as string[] }
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', () => ({ cwd: 'C:/project' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return seen
}

const START = { cwd: 'C:/project', surface: 'desktop', isInteractive: true } as const
const step = (model: string) => ({ turnId: 't1', index: 0, model, messageCount: 4 })
const measure = (tokens: number) => ({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] }) as const

async function runStep($: { turn: { step: (e: ReturnType<typeof step>) => AsyncGenerator<unknown, unknown> & { result: Promise<unknown> } } }, model: string) {
  const stream = $.turn.step(step(model))
  for await (const _ of stream) {
    // read to the end
  }
  await stream.result
}

test('warns once, five minutes before a big session goes cold, with what coming back costs', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 896_000)
  await $.session.start(START as never)
  await $.session.measure(measure(896_000) as never)
  await runStep($ as never, 'claude-fable-5-1')

  await clock.advance(54 * 60_000)
  expect(seen.toasts.filter(t => t.includes('goes cold')).length).toBe(0)

  await clock.advance(2 * 60_000)
  const warnings = seen.toasts.filter(t => t.includes('goes cold'))
  expect(warnings.length).toBe(1)
  // Fable 5.1 writes at $20/M and re-reads at $0.25/M: one cold return costs about 80 warm messages.
  expect(warnings[0]).toContain('896K')
  expect(warnings[0]).toContain('about 80 ordinary messages')
  expect(warnings[0]).not.toContain('your week')

  await clock.advance(10 * 60_000)
  expect(seen.toasts.filter(t => t.includes('goes cold')).length).toBe(1)
})

test('stays quiet for small sessions', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 60_000)
  await $.session.start(START as never)
  await $.session.measure(measure(60_000) as never)
  await runStep($ as never, 'claude-opus-5-5')
  await clock.advance(70 * 60_000)
  expect(seen.toasts.length).toBe(0)
})

test('subagent requests do not count as the main conversation', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 500_000)
  await $.session.start(START as never)
  await $.session.measure(measure(500_000) as never)
  const stream = $.turn.step({ ...step('claude-opus-5-5'), agentId: 'a1' } as never)
  for await (const _ of stream) {
    // read to the end
  }
  await clock.advance(70 * 60_000)
  expect(seen.toasts.filter(t => t.includes('goes cold')).length).toBe(0)
})

test('nudges a wrap-up once at the set size and once at twice it', async ($, on) => {
  mock.clock(on)
  const seen = engine(on)
  await $.session.start(START as never)
  await $.session.measure(measure(410_000) as never)
  await $.session.measure(measure(450_000) as never)
  await $.session.measure(measure(820_000) as never)
  expect(seen.toasts.filter(t => t.includes('/wrapup and start a fresh session')).length).toBe(2)
})

test('/wrapup sends the wrap-up prompt as the user', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  await $.session.start(START as never)
  expect(seen.commands).toContain('wrapup')
  const ran = await $.command.run({ command: 'wrapup', args: '' } as never)
  expect(ran.text).toContain('Wrapping up')
  await clock.advance(10)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('TRACKER.md')
})

test('holds the third identical failing command once, then lets it through', async ($, on) => {
  mock.clock(on)
  engine(on)
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { result: undefined, isError: true, text: 'exit 1' } as never
  })
  const call = () => $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await call()
  await call()
  const held = (await call()) as { isError?: boolean; text?: string; deny?: string }
  expect(runs).toBe(2)
  expect(String(held.text ?? held.deny)).toContain('paused this command')
  await call()
  expect(runs).toBe(3)
})

test('a successful edit clears the failure count', async ($, on) => {
  mock.clock(on)
  engine(on)
  let runs = 0
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit') return { result: undefined, text: 'ok' } as never
    runs += 1
    return { result: undefined, isError: true, text: 'exit 1' } as never
  })
  const bash = () => $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await bash()
  await bash()
  await $.tool.call({ tool: 'Edit', file_path: 'C:/project/a.ts', old_string: 'a', new_string: 'b' } as never)
  await bash()
  expect(runs).toBe(3)
})

test('/wrapup lists dead ends with their error and what worked after them', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit') return { result: undefined, text: 'ok' } as never
    const command = (e as { command: string }).command
    if (command.includes('npx vitest')) return { result: undefined, text: 'ok' } as never
    return {
      result: undefined,
      isError: true,
      text: 'Exit code 1\n> app@1.0.0 test\nsh: jest: command not found',
    } as never
  })
  await $.session.start(START as never)
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as never)
  await bash('cd app && npm test')
  await bash('cd app && npm test')
  // An edit clears the retry guard, but not the dead end.
  await $.tool.call({ tool: 'Edit', file_path: 'C:/project/a.ts', old_string: 'a', new_string: 'b' } as never)
  await bash('cd app && npm test')
  await bash('npm run lint')
  await bash('npx vitest run')
  await bash('npx vitest run --coverage')

  await $.command.run({ command: 'wrapup', args: '' } as never)
  await clock.advance(10)
  const prompt = seen.prompts[0]!
  expect(prompt).toContain('2. Dead ends.')
  expect(prompt).toContain('`cd app && npm test` (Bash) failed 3 times: sh: jest: command not found.')
  // `npx` is a different program from `npm`, so nothing counts as having worked.
  expect(prompt).toContain('Nothing seen working after it.')
  // A command that failed once is not a dead end.
  expect(prompt).not.toContain('npm run lint')
  expect(prompt).toContain('4. Reply in at most three short lines')
})

test('a dead end notes the next command of the same program that worked', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  on('tool.call', ($, e) => {
    const command = (e as { command: string }).command
    if (command === 'npm run test:unit') return { result: undefined, text: 'ok' } as never
    return { result: undefined, isError: true, text: 'npm error Missing script: "test"' } as never
  })
  await $.session.start(START as never)
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as never)
  await bash('npm test')
  await bash('npm test')
  await bash('npm run test:unit')
  await $.command.run({ command: 'wrapup', args: '' } as never)
  await clock.advance(10)
  expect(seen.prompts[0]).toContain('Seen working after it: `npm run test:unit`.')
})

test('/wrapup has no dead-end step without dead ends, and a finished wrap-up clears them', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  on('tool.call', () => ({ result: undefined, isError: true, text: 'exit 1' }) as never)
  await $.session.start(START as never)
  await $.command.run({ command: 'wrapup', args: '' } as never)
  await clock.advance(10)
  expect(seen.prompts[0]).not.toContain('Dead ends')
  expect(seen.prompts[0]).toContain('3. Reply in at most three short lines')

  await $.tool.call({ tool: 'PowerShell', command: 'pnpm build' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'pnpm build' } as never)
  await $.command.run({ command: 'wrapup', args: '' } as never)
  await clock.advance(10)
  expect(seen.prompts[1]).toContain('`pnpm build` (PowerShell) failed 2 times')
  await $.turn.complete({ turnId: 't2', isAborted: false, answer: '' } as never)

  await $.command.run({ command: 'wrapup', args: '' } as never)
  await clock.advance(10)
  expect(seen.prompts[2]).not.toContain('Dead ends')
})

test('deadEnds off leaves them out of /wrapup', { options: { deadEnds: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  on('tool.call', () => ({ result: undefined, isError: true, text: 'exit 1' }) as never)
  await $.session.start(START as never)
  await $.tool.call({ tool: 'Bash', command: 'make' } as never)
  await $.tool.call({ tool: 'Bash', command: 'make' } as never)
  await $.command.run({ command: 'wrapup', args: '' } as never)
  await clock.advance(10)
  expect(seen.prompts[0]).not.toContain('Dead ends')
})

test('the band shows the countdown on the terminal and the desktop', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, 500_000)
  await $.session.start(START as never)
  await $.session.measure(measure(500_000) as never)
  await runStep($ as never, 'claude-opus-5-5')
  await clock.advance(50 * 60_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-guardian',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    expect(await ui.find({ type: 'Text', text: /Cache warm 10 min more/ })).toBeDefined()
    await ui.unmount()
  }
})

/** A user prompt, its main-thread step and the end of its turn. */
async function exchange($: never, text: string) {
  const h = $ as { prompt: { submit: (e: unknown) => Promise<unknown> }; turn: { complete: (e: unknown) => Promise<unknown> } }
  await h.prompt.submit({ text, origin: { kind: 'human' } })
  await runStep($, 'claude-opus-5-5')
  await h.turn.complete({ turnId: 't1', isAborted: false, answer: '' })
}

const mountBand = async ($: never) =>
  (
    $ as {
      ui: { mount: (e: unknown) => Promise<{ find: (q: unknown) => Promise<unknown>; unmount: () => Promise<void> }> }
    }
  ).ui.mount({
    plugin: 'session-guardian',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  })

/** A clock time as the band writes it. */
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('saves a quiet session once, ten minutes before its cache goes cold', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 200_000)
  await $.session.start(START as never)
  await $.session.measure(measure(200_000) as never)
  await exchange($ as never, 'Fix the contact form')
  expect(seen.prompts.length).toBe(1)

  await clock.advance(49 * 60_000)
  expect(seen.prompts.length).toBe(1)

  await clock.advance(2 * 60_000)
  expect(seen.prompts.length).toBe(2)
  expect(seen.prompts[1]).toContain('Autosave from session-guardian')
  expect(seen.prompts[1]).toContain('TRACKER.md')
  expect(seen.prompts[1]).toContain('plain words')
  await runStep($ as never, 'claude-opus-5-5')
  await $.turn.complete({ turnId: 't2', isAborted: false, answer: '' } as never)

  // The save was a request, so the cache stays warm an hour from it.
  const savedAt = clock.now()
  let ui = await mountBand($ as never)
  const warm = `Saved automatically at ${hhmm(savedAt)}, warm until ${hhmm(savedAt + 60 * 60_000)}. Back by then`
  expect(await ui.find({ type: 'Text', text: new RegExp(warm.replace('.', '\\.')) })).toBeDefined()
  await ui.unmount()

  // Nothing new was asked, so no second save and no cold warning.
  await clock.advance(120 * 60_000)
  expect(seen.prompts.length).toBe(2)
  expect(seen.toasts.filter(t => t.includes('goes cold')).length).toBe(0)
  ui = await mountBand($ as never)
  expect(await ui.find({ type: 'Text', text: /the cache has gone cold since/ })).toBeDefined()
  await ui.unmount()

  // A new question makes the session worth saving again.
  await exchange($ as never, 'Now the footer')
  await clock.advance(51 * 60_000)
  expect(seen.prompts.length).toBe(4)
  expect(seen.prompts[3]).toContain('Autosave from session-guardian')
})

test('no autosave while a turn is still running, or once the cache is cold', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 200_000)
  await $.session.start(START as never)
  await $.session.measure(measure(200_000) as never)
  // The prompt goes in but its turn never completes: Claude is still working.
  await $.prompt.submit({ text: 'Run the long migration', origin: { kind: 'human' } } as never)
  await runStep($ as never, 'claude-opus-5-5')
  await clock.advance(55 * 60_000)
  expect(seen.prompts.length).toBe(1)

  // The turn ends after the cache went cold: too late to save cheaply, so nothing is sent.
  await clock.advance(10 * 60_000)
  await $.turn.complete({ turnId: 't1', isAborted: false, answer: '' } as never)
  await clock.advance(5 * 60_000)
  expect(seen.prompts.length).toBe(1)
})

test('sessions under 20K tokens are not autosaved', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 12_000)
  await $.session.start(START as never)
  await $.session.measure(measure(12_000) as never)
  await exchange($ as never, 'What time is it in Tirana?')
  await clock.advance(55 * 60_000)
  expect(seen.prompts.length).toBe(1)
})

test('autoSaveMinutes 0 turns the autosave off', { options: { autoSaveMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 200_000)
  await $.session.start(START as never)
  await $.session.measure(measure(200_000) as never)
  await exchange($ as never, 'Fix the contact form')
  await clock.advance(58 * 60_000)
  expect(seen.prompts.length).toBe(1)
})

/** Answers every tool call, failing those on a path with `locked` in it. */
function answerTools(on: On) {
  on('tool.call', ($, e) => {
    const path = (e as { file_path?: string }).file_path ?? ''
    return path.includes('locked')
      ? ({ result: undefined, isError: true, text: 'EBUSY: resource busy or locked' } as never)
      : ({ result: undefined, text: 'ok' } as never)
  })
}

/** A user prompt whose main turn makes these tool calls, then ends. */
async function turnWith($: never, text: string, calls: object[]) {
  const h = $ as {
    prompt: { submit: (e: unknown) => Promise<unknown> }
    tool: { call: (e: unknown) => Promise<unknown> }
    turn: { complete: (e: unknown) => Promise<unknown> }
  }
  await h.prompt.submit({ text, origin: { kind: 'human' } })
  await runStep($, 'claude-opus-5-5')
  for (const call of calls) await h.tool.call(call)
  await h.turn.complete({ turnId: 't1', isAborted: false, answer: '' })
}

test('no autosave when the turn ended by writing the session notes', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 472_000)
  answerTools(on)
  await $.session.start(START as never)
  await $.session.measure(measure(472_000) as never)
  // How a session that keeps the rules in rules/CLAUDE.md ends a turn: the handover by Edit, its
  // SESSIONS.md row by a script, then the app's title, marker and wrap-up tools.
  await turnWith($ as never, 'Compare the TikTok prices', [
    { tool: 'Bash', command: 'grep -n "^## " REDSUPPLY-HANDOVER.md' },
    { tool: 'Read', file_path: 'C:\\Users\\a\\RedSocial\\REDSUPPLY-HANDOVER.md' },
    { tool: 'Edit', file_path: 'C:\\Users\\a\\RedSocial\\REDSUPPLY-HANDOVER.md', old_string: 'a', new_string: 'b' },
    { tool: 'Bash', command: "cd RedSocial && python - <<'EOF'\np='SESSIONS.md'\nEOF" },
    { tool: 'mcp__ccd_session_mgmt__set_session_title', session_id: 'self', title: '@#114 RedSocial' },
    { tool: 'mcp__ccd_sidebar__set_unread', session_id: 'self', unread: true },
    { tool: 'mcp__ccd_turn__wrap_up', recap: 'Saved.' },
  ])
  await clock.advance(55 * 60_000)
  expect(seen.prompts.length).toBe(1)
  // The cache countdown still runs: coming back still costs a rewrite.
  expect(seen.toasts.filter(t => t.includes('goes cold')).length).toBe(1)

  // A new question with no notes written makes the session worth saving again.
  await exchange($ as never, 'And the Likes prices?')
  await clock.advance(51 * 60_000)
  expect(seen.prompts.length).toBe(3)
  expect(seen.prompts[2]).toContain('Autosave from session-guardian')
})

test('still autosaves when the turn went on after its notes, or the notes write failed', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 200_000)
  answerTools(on)
  await $.session.start(START as never)
  await $.session.measure(measure(200_000) as never)

  // The first reply takes its session number, then does the work.
  await turnWith($ as never, 'Build the footer', [
    { tool: 'Write', file_path: 'C:/project/tracker.md', content: '- #W4 · main · footer · working' },
    { tool: 'Edit', file_path: 'C:/project/src/footer.tsx', old_string: 'a', new_string: 'b' },
    { tool: 'mcp__ccd_turn__wrap_up', recap: 'Footer built.' },
  ])
  await clock.advance(51 * 60_000)
  expect(seen.prompts.length).toBe(2)
  expect(seen.prompts[1]).toContain('Autosave from session-guardian')
  await $.turn.complete({ turnId: 't2', isAborted: false, answer: '' } as never)

  // Research after the notes is news the notes lack.
  await turnWith($ as never, 'Which icon set?', [
    { tool: 'Edit', file_path: 'C:/project/SESSIONS.md', old_string: 'a', new_string: 'b' },
    { tool: 'WebSearch', query: 'open source icon sets 2026' },
  ])
  await clock.advance(51 * 60_000)
  expect(seen.prompts.length).toBe(4)
  await $.turn.complete({ turnId: 't3', isAborted: false, answer: '' } as never)

  // A notes write that failed saved nothing.
  await turnWith($ as never, 'Note the icon choice', [
    { tool: 'Edit', file_path: 'C:/project/locked/Site-Handover.md', old_string: 'a', new_string: 'b' },
  ])
  await clock.advance(51 * 60_000)
  expect(seen.prompts.length).toBe(6)
  expect(seen.prompts[5]).toContain('Autosave from session-guardian')
})

test('a subagent writing a notes file does not count as the session saving', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 200_000)
  answerTools(on)
  await $.session.start(START as never)
  await $.session.measure(measure(200_000) as never)
  await turnWith($ as never, 'Audit the site', [
    { tool: 'Write', file_path: 'C:/project/audit/TRACKER.md', content: '- audit', agentId: 'a1' },
  ])
  await clock.advance(51 * 60_000)
  expect(seen.prompts.length).toBe(2)
})

test('adds the share of the week when weeklyUsd is set', { options: { weeklyUsd: 1770 } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, 896_000)
  await $.session.start(START as never)
  await $.session.measure(measure(896_000) as never)
  await runStep($ as never, 'claude-fable-5-1')
  await clock.advance(56 * 60_000)
  // 896K at $20/M is $17.92, about 1.0% of a $1,770 week.
  expect(seen.toasts.find(t => t.includes('goes cold'))).toContain('about 1.0% of your week')
})
