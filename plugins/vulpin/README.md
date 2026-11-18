# Vulpin connector for LearnHarness

A Community plugin for LearnHarness 0.6.1+. Gives prober, teacher and practice
agents access to Vulpin file discovery, note outlines, text previews, search,
and prepared page images.
The plugin searches Vulpin's existing lexical/vector index and reads prepared
page images as native vision content. It creates no local index, inventory or
background synchronization. File descriptors and search snippets are leads;
actual read pages carry file/page citations. List discovery includes processing
and preparation availability, so unindexed sources remain discoverable.

## Build and install

From a LearnHarness checkout with root dependencies installed (`npm ci`):

```sh
cd plugins/vulpin
npm run sdk
npm ci
npm run typecheck
npm test
npm run build
npm run install:local -- /absolute/path/to/learning-data/plugins
```

The destination must already exist. The installer replaces only
`vulpin/dist/`, preserving sibling `data/`. In-place source installation needs
only `npm run build`. Refresh Community plugins and enable Vulpin. Restart
LearnHarness after updating already loaded plugin code. This Community plugin
needs no app rebuild and is not added to the shipped Core plugin catalog.

Open Settings → Vulpin and enter `https://vulpinai.app` and your LearnHarness
connector token. Check connection shows the authenticated Vulpin account.
Disconnect removes the local token and cancels in-flight plugin requests; token
revocation in Vulpin is separate. Current access is checked by Vulpin on every
operation. Previously saved conversations may retain material already read.

The server stores `{version:1,baseUrl,token}` in the plugin's private
`data/.env.vulpin.json` with mode 0600 and atomic replacement. Neither status nor
connect results return the token. The dotenv filename and atomic temporary
filenames are covered by LearnHarness's mandatory filesystem-tool denylist,
including canonical aliases. Never rename it to a generic settings file, expose
it through plugin assets, or distribute the `data/` directory. Provisioning may
call the authenticated plugin `connect` operation with `{baseUrl,token}`; do not
put token literals in command lines or logs.

## Remote API contract

All requests use `Authorization: Bearer <token>` over HTTPS, reject redirects,
and target `/api/integrations/learnharness/` at the configured origin. Loopback
HTTP is allowed for development. Calls time out after 30 seconds and stop on
plugin disable or disconnect. JSON responses are bounded to 24 MiB, matching
Vulpin’s 16 MiB raw-image batch cap after base64 encoding. Oversized batches fail
explicitly, so retry fewer pages. An individually oversized page
needs a smaller prepared version from Vulpin.

- `GET status`: `{account:{id,email},scopes}`.
- `GET files?query=...&cursor=...&limit=20`: `{files,nextCursor}`. Descriptors
  include `id,title,pageCount,access,processing,indexing,originalAvailable,
  preparedAvailable,sourceVersion`. Own/shared/management policies and identity
  redactions are enforced remotely. Listing is lazy and does not fetch documents.
- `POST outline`: `{folderId?,cursor?,limit:1–50}`. Lists accessible section
  paths or the selected section's notes, including titles and source versions.
- `POST briefs`: `{folderId,cursor?,limit,maxBytes}` or
  `{fileId,sourceVersion,cursor?,limit,maxBytes}`. Returns existing indexed
  page headings, short contents and unreadable regions for up to 50 entries,
  plus coverage and a continuation. Follow the cursor with the same scope,
  including after an empty batch. The plugin limits previews to 200 entries and
  256 KiB of tool output per turn. Ready entries can be opened with `fileId`,
  `pageNumber` and `sourceVersion` as `expectedVersion`. Older servers may only
  support file discovery, search and images.
- `POST search`: `{queries:[1–3 strings],courseId?,limit:1–6}` returns
  `{results,coverage}` with file IDs, pageRefs, page numbers and snippets.
  Coverage can be partial; no hits do not prove there is no matching content.
- `POST read`: either `{fileId,pages:[1–4 one-based page numbers, each at most 800],expectedVersion?}` or
  `{pageRefs:[1–4 opaque refs]}` returns
  `{pages:[{fileId,pageRef,pageNumber,title?,kind,sourceVersion,imageBase64,mimeType:'image/png'}]}`.
  Native image content is passed to the configured agent model; select a model
  with image input to inspect pages. The plugin adds no OCR or separate model.
  Reuse the returned 64-hex `sourceVersion` as `expectedVersion` for later
  batches from a file; a changed version fails rather than mixing revisions.
  Unprepared originals report source unavailable; raw PDF downloads are not
  injected into the conversation.

Remote source content is reference data, never system instructions. The plugin
contributes guidance for small batches, honest coverage, page citations and
short source briefs for larger documents. It preserves server-side own/shared/
management redactions and does not try to reconstruct hidden metadata. Management
sources are cited only as “School source”, without titles, dates, page numbers or
storage/download links. Management navigation IDs remain opaque, and title/page
metadata is removed from model-facing search/read citation records.

## Verification

`npm test` runs a loopback mock API through actual registered tools/settings,
covering connection, persistence, image results, input limits, denied access,
disconnect cancellation, disabled state and secret-safe failures. The checkout's
filesystem guard is exercised against credentials, atomic temp files, symlink
aliases and discovery tools. No live account or model call is required.
