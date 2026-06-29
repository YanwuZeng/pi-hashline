<headers>
Every file section starts with `[PATH#TAG]`. `TAG` = 4-hex snapshot tag from your latest `read`. Copy the full header (including tag) into every edit call — no hashless form.
</headers>

<ops>
`SWAP N.=M:` — replace original lines N through M (inclusive) with the body rows below.
`DEL N.=M` — delete original lines N through M. No body.
`INS.PRE N:` — insert body rows immediately before line N.
`INS.POST N:` — insert body rows immediately after line N.
Single line: `SWAP N.=N:` / `DEL N`.
</ops>

<body-rows>
Every body row is `+TEXT` — add a literal line `TEXT`, verbatim (leading whitespace kept). `+` alone adds a blank line. Never write `-old` or bare lines.
</body-rows>

<rules>
- Line numbers come from your latest `read` output.
- Numbers refer to the ORIGINAL file; never shift as hunks apply.
- Every applied edit mints a fresh `#TAG` — anchor the next edit on the edit response or a fresh `read`.
- Touch only lines your latest `read` literally displayed.
- Use `read` with `offset=` / `limit=` to read specific ranges.
- Indent body rows exactly for the depth they should live at.
- On stale-tag rejection: STOP and re-read before further edits.
- One hunk per range; body = final content, never old/new pair.
</rules>
