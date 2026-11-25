# The conversation in a .temen (format 2)

A `.temen` project can carry the assistant conversation that made it, so the web app, the iPhone and iPad
app and anything else built on the core can open a project and carry on: the transcript, the model's
messages (so the assistant has its history), the undo points and the attachments.

The core reads and writes it (`core/src/conversation.c`, `temen_conversation_pack` and
`temen_conversation_unpack` in `temencad.h`); each app maps its own chat state to the JSON below and
back. Earlier formats are not read.

## In the archive

```
.assistant/conversation.json   the conversation (below)
.assistant/blobs/<sha256>      raw bytes, named by the lowercase hex SHA-256 of their contents
```

Every blob is referenced from `conversation.json`; the core writes only referenced blobs and checks each
blob's hash when it reads them. Other entries under `.assistant/` are left alone (an app may keep its own
data there).

## Bytes in the JSON

Binary content appears in two ways, and the core converts between the app's form and the archive's:

- **Inline**, a base64 source as the Messages API writes it:
  `{"type": "base64", "media_type": "image/png", "data": "iVBOR…"}`.
  In the archive `data` becomes `"$blob": "<sha256>"`; reading restores `data`. Used for API messages and
  for the images in transcript entries, which apps hold in memory anyway.
- **By reference**: `{"$blob": "<key>"}`, optionally with `media_type`. When packing, the key is any id the
  app likes and the bytes are passed alongside (`TemenBlob`); the archive uses the SHA-256. Reading leaves
  the reference with its SHA-256 key and hands back the bytes. Used for checkpoint files and attachments,
  which are large, repeat across checkpoints and live in each app's own blob store.

Any object with a string `$blob` is a reference; nothing else is.

## conversation.json

```json
{
  "format": 2,
  "app": "TemenCAD web",
  "entries": [],
  "messages": [],
  "notes": [],
  "attachments": [],
  "checkpoints": []
}
```

- `format` (required): 2.
- `app`: what wrote it, for diagnostics ("TemenCAD web", "TemenCAD for iPhone and iPad").
- `entries` (required): the transcript as the user sees it, oldest first (below).
- `messages` (required): the Messages API conversation exactly as sent (user and assistant turns, tool
  use and results, thinking blocks with their signatures), with base64 sources as above.
- `notes`: things the user did that the model has not yet been told (an undo, a put back), sent in
  `<app_events>` with the next message.
- `attachments`: what the user attached, in order: "Attachment n" in the messages is `attachments[n-1]`.
  Each is `{"name": "drawing.pdf", "media_type": "application/pdf", "data": {"$blob": "…"}}`.
- `checkpoints`: the project's files at moments in the conversation, each a map from file name to
  `{"$blob": "…"}`. Reply and event entries refer to them by index. They all belong to this project: an
  app that carries a conversation into another project drops the undo points of the earlier one.

### Entries

Each has a `kind`; readers skip kinds they do not know, showing `text` if there is one, and ignore
fields they do not know.

| kind | fields |
| --- | --- |
| `user` | `text`; `attachments`: `[{kind, name, size?, image?, text?, color?, color_name?}]` where kind is `image`, `pdf`, `file` (added to the project), `reference` (a surface pointed at; `text` describes it, `color` is `#rrggbb`, `color_name` what the model was told, "blue") or `measurement` (`text`); `image` is an inline base64 source (the photo, or a thumbnail of it; the view with the references) |
| `assistant` | `text` (Markdown) |
| `tool` | `name`: the tool the assistant ran (apps show their own label) |
| `status` | `text`: a line from the app ("Opened Bracket.temen.") |
| `error` | `text` |
| `image` | `image`: inline base64 source; `caption` (a screenshot or rendered views shown in the chat) |
| `file` | `name`, `size?`, `text?`: a file the assistant exported (the bytes are not kept) |
| `card` | `text`, `answer?`, `labels?` (its buttons): a question card the user has answered or dismissed |
| `reply` | `message` (the user's message it answered), `changed`, `before?`, `after?` (checkpoint indexes when it changed the project), `summary?` ("main.js +3 −1") |
| `event` | `message` (of the reply concerned), `undo` (true: an undo; false: a put back), `put_back` (the checkpoint that reverses it), `used` |
