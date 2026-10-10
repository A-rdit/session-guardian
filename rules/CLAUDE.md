# Session Guardian rules

Paste the first two sections into `~/.claude/CLAUDE.md` to use them in every project, or into
one project's `CLAUDE.md` to try them there first. A project's own rules win over the global
file. The third section is optional; see its note.

## Session ID and sidebar markers

For the main session only. Subagents, background agents and scheduled tasks skip this.

1. **First reply, before anything else:** open `SESSIONS.md` in this session's working folder.
   If it doesn't exist, create it from the template below. Pick a prefix of 1 to 3 capital
   letters from the folder name (for example `W` for a website project) and a short project
   name. Take the next free number and append your row (number, date, chapter, status
   "working"). Re-read the file just before writing, since other sessions in the folder may
   have taken that number. Then rename this session to
   `#<prefix><number> <project> · <chapter in a few words>`, for example
   `#W4 Website · contact form`. In the Claude desktop app the tool is
   `mcp__ccd_session_mgmt__set_session_title` (session_id "self"); where there is no rename
   tool, write the ID in your first line instead. Do this alongside the real work, in a
   couple of tool calls.
2. **Keep the title honest.** `@` in front when a reply or decision is waiting on the user
   (in the desktop app also call `mcp__ccd_sidebar__set_unread`, self, true; remove the `@` in
   the turn after they answer). `✓` in front when the chapter is done (status "done" in
   `SESSIONS.md`; in the desktop app also call `mcp__ccd_sidebar__mark_completed`, self). `!`
   in front when blocked on something outside the user. Update the chapter words if the work
   moves to a new topic.
3. **Before the session ends or its chapter is done, save its state** so a fresh session can
   pick up without this chat: one line in the Status column saying where it stopped and what
   comes next, and the project's `TRACKER.md` (next section). Starting fresh from these notes
   costs far less usage than resuming a long session after its cache has gone cold.
4. Never rename another session. Tools named here may be deferred: load them with ToolSearch
   first.

Template for a new `SESSIONS.md`:

```markdown
# Session register (<project>)

Prefix: `<prefix>`. Every main session in this folder takes the next free number in its first
reply and renames itself: `#<prefix><number> <project> · <chapter>`.
Markers in front of the title: `@` waiting on the user, `✓` done, `!` blocked.

| # | Date | Chapter | Status |
| --- | --- | --- | --- |
```

## Branch and Progress Tracker

For every project whose work runs over more than one session.

`TRACKER.md` at the project root is the one file a new session reads to pick up the work.
Create it when a session ends with work left for another session, or when the user asks. Read
it first, before the project's other notes.

1. **Sessions block, at the top.** One line per session, newest first, at most 5:
   `#W4 · <branch> · <what it is doing> · <status>`, with the title's markers (`@`, `✓`, `!`).
   A session adds its line in its first reply (its number still comes from `SESSIONS.md`) and
   after that edits only its own line. When a sixth line goes in, the oldest finished (`✓`)
   line moves to `TRACKER-ARCHIVE.md`. Never remove the line of a session that is still
   working, even if that leaves more than 5.
2. **Waiting on the user.** A short list, each item naming the branch it holds up.
3. **Branches.** One heading per branch: its goal in one line, then its items, the next step
   first. A session edits only the branch it works on.
4. **Done items are struck out where they stand, with the date:** `~~item~~ (done 10 Oct)`. At
   most 5 struck-out items in the whole file, as a reminder of what just finished. When a sixth
   is struck, the oldest moves to `TRACKER-ARCHIVE.md`; so does a branch with nothing left in
   it.
5. **Keep it short and safe.** One line per item; details go in the project's other notes,
   named by file. Edit, never rewrite the whole file, and re-read it right before each edit,
   since other sessions edit it too. `TRACKER-ARCHIVE.md` is append-only, newest on top, and
   nobody needs to read it to pick up.
6. **Before the session ends:** update your Sessions line and your branch, and add anything new
   that came up. The `/wrapup` command from the Session Guardian plugin asks for exactly this.

Template for a new `TRACKER.md`:

```markdown
# Tracker (<project>)

Read this first. Rules: CLAUDE.md, "Branch and Progress Tracker".

## Sessions (newest first, at most 5)

- #W1 · <branch> · <what it is doing> · working

## Waiting on the user

- Nothing yet.

## Branches

### <Branch name>

Goal: <one line>

- <next step>
- ~~<a finished item>~~ (done 10 Oct)
```

## TLDR on long replies (optional)

Optional because it spends a little usage: one or two extra lines of output per long reply,
which then sit in the context for the rest of the session. That is small next to a cold return,
and if you often come back to a session lost, the last message then tells you at a glance where
things stand, so you can start a fresh session from it instead of asking the old one for
details.

Only in the final message of a turn, never in progress notes between tool calls, and only when
that final message is long: about 300 words or more, or it has headers or several lists. Then
end it with a TLDR of one or two lines in plain language: what was found or done, what comes
next, and what waits on the user. One TLDR per turn, nothing before it that already says the
same. Short replies get none. Progress notes between tool calls stay to one line each and never
repeat earlier ones. Subagents and scheduled tasks skip this.
