# skill-loader

Codex-style skill loading for [pi](https://github.com/mariozechner/pi-coding-agent):
type `#skillname` to load a skill into context without consuming an LLM turn.

## Install

```sh
pi install npm:pi-skill-loader
```

Or try it for one session without installing:

```sh
pi -e npm:pi-skill-loader
```

## Usage

Type `#` anywhere in the editor and the skill box opens automatically, no
Tab needed. Pick a skill with Tab/Enter and it is rewritten to a
`{$skill}` marker, tinted with your theme's accent color so pending loads
are visible. Esc dismisses the box and leaves plain text that will not
load. You can also type the `{$skill}` marker by hand.

| Input | Behavior |
|---|---|
| `{$skill}` (selected or typed) | Load a skill, no LLM turn consumed |
| `review this {$style}` | Load the skill and send the message as written |
| `#` | Open the skill picker menu |
| `/skills` | List currently loaded skills |
| `/skills-clear` | Reset loaded skill tracking |

Only `{$...}` markers load. Plain `#words`, hashtags, and pasted markdown
pass through to the agent untouched and never load. Mentions stay in your
message so the reference remains visible. A message holding only skill
markers loads them without consuming a turn. Each skill is submitted once
as a context message when first loaded, without starting a model turn. Repeated mentions do not resubmit it. Loaded-skill
tracking persists across `/reload` and follows the current session branch.
Skill content remains in conversation history, subject to normal compaction.
`/skills-clear` resets tracking so skills can be loaded again; it does not
erase previously submitted content. Unreadable or empty skills report an
error and are not marked loaded.

Highlighting replaces the editor component while installed; if another
extension already owns it, highlighting is skipped with a warning and
everything else keeps working.
