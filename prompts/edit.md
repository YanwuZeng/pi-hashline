<headers>
Every file section starts with `[PATH#TAG]`. `TAG` = 4-hex snapshot tag from your latest `read`, REQUIRED on every section.
</headers>

<ops>
`SWAP N.=M:` — replace original lines N through M (inclusive) with the body rows below.
`DEL N.=M` — delete original lines N through M. No body.
`INS.PRE N:` — insert the body rows immediately before line N.
`INS.POST N:` — insert the body rows immediately after line N.
`INS.HEAD:` / `INS.TAIL:` — insert at the very start / end of the file.
Single line: `SWAP N.=N:` / `DEL N`.
</ops>

<body-rows>
Body rows appear only under a `:` header. Every body row is `+TEXT` — add a literal line `TEXT`, verbatim (leading whitespace kept). `+` alone adds a blank line. Never write `-old` or a bare/context line.
</body-rows>

<rules>
- Line numbers come from your latest `read` output (`LINE:TEXT` rows).
- Numbers refer to the ORIGINAL file; never shift as hunks apply.
- Every applied edit mints a fresh `#TAG` and renumbers — anchor the next edit on the edit response or a fresh `read`.
- Touch only lines your latest `read` literally displayed; the tag certifies the snapshot.
- On stale-tag rejection: STOP and re-read before further edits.
- One hunk per range; body = final content, never an old/new pair.
- Ranges cover ONLY lines whose content changes. Never widen over unchanged lines.
- Indent body rows exactly for the depth they should live at.
- Pure additions use `INS.PRE` / `INS.POST` / `INS.HEAD` / `INS.TAIL`, never a widened `SWAP`.
</rules>
