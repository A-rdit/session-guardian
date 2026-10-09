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
