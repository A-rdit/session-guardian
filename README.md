# Session Guardian

A Claude Code plugin and two CLAUDE.md rules that keep long sessions cheap to run and easy to
pick up again.

## Why

In a long Claude Code session, most of your usage doesn't go to Claude writing code. It goes to
Claude re-reading the conversation, on every message. That re-reading is cheap while the
conversation is cached, and the cache lasts an hour after your last message (on a Claude
subscription, for the main conversation). Come back later and your first message writes the
whole conversation into the cache again, at twice the normal input price.

In one heavy user's month of logs, about 15% of all usage went to these cold returns. A fresh
session that reads a short tracker file cost about as much as eight messages in a very large
session, and every message after that was far cheaper.

Session Guardian shows you the expensive moments before they happen, and makes starting fresh
safe.

The habits behind it fit on two pages: [Claude Code good practices (PDF)](docs/claude-code-good-practices.pdf),
free to share.

## What the plugin does

- **Countdown before the cache goes cold.** For sessions over 150K tokens, a line above the
  prompt counts down the last 15 minutes and says what coming back after that will cost. One
  pop-up comes 5 minutes before.
- **Wrap-up nudge.** At 400K tokens, and again at 800K, a pop-up suggests wrapping up and
  starting fresh.
- **`/wrapup`.** Claude saves where the session stopped (in `TRACKER.md`, or wherever your
  CLAUDE.md rules say), marks the session done and gives you a one-line prompt to start the
  next one. The line above the prompt then says it's safe to archive.
- **Retry guard.** When the same Bash or PowerShell command fails twice in a row with no edit
  in between, the third identical try is paused once and Claude is asked to fix the cause
  first. Sending the same command again runs it.

Costs are shown in ordinary messages: a cold return of a Fable 5.1 session costs as much as
about 80 warm messages, Opus 5.5 about 40, Sonnet about 20. If you set `weeklyUsd`, they are
also shown as a share of your weekly limit.

## The rules

`rules/CLAUDE.md` holds two rules for Claude. They work with or without the plugin.

- **Session ID and sidebar markers.** Every session takes a number from `SESSIONS.md` and
  renames itself, like `#W4 Website · contact form`. A marker in front of the title says where
  it stands: `@` waiting on you, `✓` done, `!` blocked.
- **Branch and Progress Tracker.** Every project that runs over more than one session keeps a
  `TRACKER.md`. The five latest sessions sit at the top, and each one edits only its own line,
  so sessions running side by side don't overwrite each other. Below that come what waits on
  you and the branches of work, next step first. Finished items stay struck out as a reminder,
  five at most; older lines move to `TRACKER-ARCHIVE.md`.

Renaming and the sidebar markers use tools of the Claude desktop app. Elsewhere Claude writes
the ID in its first line instead.

## Install

The plugin needs a Claude Code version with function-hook plugins, which are early access. It
was built and tested on Claude Code 2.1.289.

From a terminal:

```bash
claude plugin marketplace add A-rdit/session-guardian
claude plugin install session-guardian@session-guardian
```

Or inside a Claude Code session in the terminal:

```
/plugin marketplace add A-rdit/session-guardian
/plugin install session-guardian@session-guardian
```

It then loads in every new session, in the terminal and in the desktop app.

For the rules, copy the two sections of `rules/CLAUDE.md` into `~/.claude/CLAUDE.md` for every
project, or into one project's `CLAUDE.md` to try them there first.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `warnMinutes` | 5 | How many minutes before the cache goes cold the pop-up comes |
| `warnFromTokens` | 150000 | Sessions smaller than this get no countdown |
| `wrapupAt` | 400000 | Size of the first wrap-up nudge; the second comes at twice this |
| `weeklyUsd` | 0 (off) | Your weekly limit in API dollars, to show costs as a share of your week |
| `retryGuard` | true | Pause the third identical failing command once |

Change them with `/plugin configure session-guardian@session-guardian` in a terminal session,
or pass them when installing: `claude plugin install session-guardian@session-guardian --config weeklyUsd=1770`.
They are stored under `pluginConfigs` in `~/.claude/settings.json`.

To find your `weeklyUsd`, take a week that filled your weekly bar and add up what its usage
would have cost at API prices. A usage tool such as
[optimAIzr](https://github.com/blendbunjaku/optimaizr) can show that figure. On a Max 20x plan in
October 2026, one such week came to about $1,770.

## How the numbers are worked out

- The plugin reads the session's context size and model from Claude Code itself. It makes no
  network calls and writes no files.
- A cold return writes the whole context into a 1-hour cache at twice the model's input price.
  A warm message reads it at the cache-read price. The ratio of the two is the "ordinary
  messages" figure.
- Prices are Anthropic's list prices of October 2026, in `plugin/hooks/register.tsx`.

## Limits

- Pop-ups and the countdown show only in that session's own window. A session running in the
  background warns nobody until you open it.
- It assumes the 1-hour cache Claude Code uses for the main conversation on a subscription.
  Subagents use a 5-minute cache and are left out. If your account moves to a shorter cache,
  for example while it draws on pay-as-you-go extra usage, the countdown is too generous.
- The share of your week assumes your limit drains in line with API prices. Anthropic doesn't
  publish how limits are counted, so treat it as a guide.

## Development

```bash
claude plugin validate plugin
claude plugin test plugin
```

The tests in `plugin/tests` cover the countdown, the nudges, `/wrapup`, the retry guard and the
band on the terminal and desktop surfaces.

## Credits

The cache countdown and the retry guard were inspired by
[optimAIzr](https://github.com/blendbunjaku/optimaizr), a local tool that finds wasted tokens in
Claude Code and Codex. Session Guardian is a smaller, separate take, focused on the desktop app
and on handing work from one session to the next.

## License

[MIT](LICENSE)
