# Colour carries state, dim carries context, and prose is never coloured

Mission control writes lines, not screens. There are no frames, no boxes and no full-screen redrawing beyond the one line a heartbeat rewrites: a line survives a pipe, a paste into a pull request and a terminal I resized, and a frame does not.

**Work that takes seconds says so.** Every command that reaches GitHub, a clone or the disk before it can print turns a heartbeat while it does, because a terminal that shows nothing for five seconds is one I stop trusting. It is one line, rewritten in place and gone the moment the work is, so what the screen keeps is the report and never the trail of what it took to get there. What the line counts belongs to the command — a review counts tools, a sweep counts pull requests, a command reading two guards counts nothing — and the clock and the rewriting belong to the heartbeat. Where there is no screen to measure, nothing is drawn: a pipe reads exactly what it read before there was a heartbeat at all.

What a line is allowed to say in more than words is fixed here, because a rule invented per command is four looks.

**Colour is state.** The bucket a pull request sits in, the severity of a finding, the stamp, and a command I am meant to retype. **`dim` is context**: a title, a commit SHA, a path, a draft marker — things I read to place what I am looking at, never things I act on. **Everything else is left alone.** Prose is never coloured, and neither is a block heading. A typical screen ends up with three or four coloured words, which is what makes them worth looking at.

The colours are the terminal's own eight, plus `bold` and `dim`. A shade of my choosing looks right in the theme I chose it in and wrong in the next one; one of the eight is whatever my theme says it is, and has contrast by construction. `needs-me` is red, `needs-review-run` yellow, `waiting-on-others` dim, `ready` green, and a finding's severity takes the same three, so one colour means one thing everywhere. A command I am meant to retype is cyan, the one colour of the eight no state uses.

Colour arrives only where a terminal is watching and `NO_COLOR` is unset. That question is asked once, of the services rather than of `process`, and the answer is the `Paint` a command writes with. `Paint` defaults to no colour, so anything that provides nothing — a test, a pipe, a path not thought of — prints the text and only the text.

**A marker does what colour does, without colour.** Each bucket carries one character (`●` `◐` `○` `◆`), so a row read in a pipe, by someone colour-blind, or under `NO_COLOR` still groups the same way. The characters stay in the part of Unicode a terminal font has and out of the part it draws double width: the columns are padded by counting characters, and a glyph two columns wide takes room the count never gave it. That rules out emoji.

**A link is ink, and it is not colour.** The reference on a table's row carries the pull request's URL for the terminal to open, through OSC 8. It says nothing about state, so it withholds nothing from the marker and takes no colour of its own, and the text on the screen is the reference either way: a terminal that ignores the sequence, a pipe and a paste all read what they read before. It arrives under the same condition colour does, so one question decides both.

**Widths are measured in what is shown.** Colour is characters a terminal never displays, so the table counts and cuts by visible width, and pads outside the colour rather than inside it. A cell cut through an escape sequence spills the sequence onto the screen and colours everything after it.

**A prompt pays for its colour, and cannot afford a link.** Effect's prompts count the rows they must erase from the length of what they drew, escape sequences included, so a coloured row erases a line above itself on every keypress unless the row is shorter by what the colour costs. A prompt's rows therefore say the bucket in one coloured cell and leave the rest of the row plain, and the room they are cut to is short by that cost. A colour costs nine characters; a link costs the whole URL, which on a pull request of mine is fifty or more, and the row it would come out of is eighty wide. The picker's rows are the table's rows without the link, which costs them nothing: a row there is something I pick, and picking it is what the picker is for.

**What gives way is the title.** When a row will not fit, the title is cut, and when cutting it would leave nothing worth reading, its column goes. What the pull request waits on is why the list is on the screen at all; the title is how I recognise a pull request I already know.

**A block is heading, indented body, blank line.** Every command that reports rather than tabulates writes in blocks, so a report reads the same whichever command wrote it.

## Consequences

- The eight colours are the terminal's, so a screenshot from my machine is not a screenshot from anyone else's. That is the price of never having to check contrast.
- A marker is one more column of information a row has to carry, and rows are what a narrow screen runs out of. That is paid for by the title, above.
- A link only reaches me where the terminal knows OSC 8. That is not asked about, because a terminal that does not know it prints the reference and nothing is lost.
- `--json` exists for the machine, so nothing here has to. There is no third format: what a pipe gets is what a terminal gets, minus the colour.
