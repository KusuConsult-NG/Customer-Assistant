# Reviewing the translations

These are the exact words the assistant says to customers on WhatsApp and on the
phone. They were written by a machine and have never been read by a native
speaker. That is what these files are for.

There is one file per language:

- `pcm.csv` — Nigerian Pidgin
- `ha.csv` — Hausa
- `ig.csv` — Igbo
- `yo.csv` — Yoruba

## What to do

Open the file in Excel, Google Sheets, Numbers or LibreOffice.

| column | what it is |
|---|---|
| `key` | the internal name. **Do not change it.** |
| `where_it_appears` | which conversation the customer is in when they read this |
| `placeholders` | see below. **Do not change these.** |
| `english` | the English original, for reference |
| `current_<lang>` | what the assistant says today |
| `corrected` | **your column.** Leave it empty if the current wording is fine. |

Only fill in `corrected` where the current wording is wrong, unclear, rude, or
simply not how a person would say it. An empty cell means "this one is fine" —
you do not need to retype anything you are happy with.

## The two rules

**1. Keep every placeholder, spelled exactly.** A placeholder is a word in curly
brackets: `{name}`, `{list}`, `{account}`. Each one is replaced with a real
value before the customer sees it — their name, a list of times, a bank account
number. You may move a placeholder to wherever it belongs in your language, but
if you drop one, the sentence promises something and then does not say it. The
importer refuses any correction that loses or invents one, so nothing can slip
through — but it costs a round-trip, so it is worth checking.

**2. `\n` means "start a new line".** Where you see the two characters `\n` in
the middle of a string, that is a line break. Keep them where the message needs
a break — most of the numbered lists depend on them.

## What NOT to translate

Some things inside these strings are deliberately left in English, and should
stay that way:

- **Plan names** — Formal Sector, Informal Sector, Equity Programme, BHCPF.
  These are printed on the customer's health card, so the words they choose from
  must be the words the card will use.
- **Place names** — Jos North, Barkin Ladi, and the hospitals.
- **`*yes*`** — the asterisks make the word bold on WhatsApp, and the system
  understands the customer's own language when they reply, so a customer may
  answer "eh", "na'am", "ee" or "beeni" as they prefer.

If something in that list reads badly in your language, say so in an email
rather than changing it here — it needs a decision, not a translation.

## Sending it back

Save as CSV (keep the same filename) and return the file. The corrections are
checked and applied automatically; nothing is edited by hand on the way in.
