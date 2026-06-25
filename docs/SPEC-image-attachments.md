# Spec — Image Attachments for Panelist Prompts

> **Status:** Draft. Dogfood target: this project's own config editor.
> **Goal:** Let a user attach screenshots, wireframes, and diagrams to a panelist's prompt by pasting, dropping, or picking — without leaving the **Config** tab.

---

## 1. Problem

The panelist config form has two prompt modes:

- **Markdown file** — a text field with a path string (e.g. `./prompts/security.md`).
- **Inline** — a `<textarea>` for the raw prompt text.

Neither accepts images. To give a panelist a wireframe or a screenshot today, the user has to:

1. Save the image somewhere.
2. Edit the markdown file by hand to add `![ref](./assets/foo.png)`.
3. Add a `<agent-id>/assets/` directory to the config.
4. Ship the asset alongside `config/panelists.json` (which currently doesn't track assets at all).

Playwright confirms the gap: a synthetic `ClipboardEvent` carrying an image into the inline `<textarea>` leaves the textarea unchanged. The form silently drops the data.

This is a real friction point when explaining visual context (UI bugs, mockups, error states) to a reviewer agent.

---

## 2. Goals & non-goals

### Goals

- **Paste / drop / pick** an image into either prompt mode; see a thumbnail; remove it; save the config.
- **No new files at the project root.** All assets live under `config/prompts/<agent-id>/assets/`, version-controlled with the prompt.
- **Round-trip safe.** Saving and reloading the form shows the same images.
- **Reuses existing infra.** Same `POST /api/config` save path; same `CouncilConfigSchema` validation; same denormalize round-trip we already tested in `tests/form-roundtrip.test.ts` (additive fields only).
- **Default-deny for hostile content.** Type allow-list, size cap, no SVG, no path traversal.

### Non-goals (this iteration)

- Editing the markdown body itself in the browser (current behavior: edit the file in your editor).
- Hosting assets at a URL the agent CLI can fetch during a run (the panelist CLI gets the rendered prompt text; embedded data URLs are enough for now).
- Multiple-file zips or arbitrary binary blobs.
- Real-time collaborative editing of the form.

---

## 3. UX

### 3.1 Inline mode

The `systemPrompt` textarea grows a paste/drop affordance:

- **Paste an image** (⌘V / Ctrl+V) into the textarea: the image is inserted at the cursor as a markdown image with an **inline data URL**:
  ```markdown
  ![pasted-2026-06-25T10-42-13Z](data:image/png;base64,iVBORw0K…)
  ```
  The textarea shows the markdown text (with the long data URL); a small `📎 1 image` chip below the textarea counts attachments.
- **Drag-and-drop** an image file onto the textarea: same behaviour.
- **Click the chip** to expand a thumbnail strip showing all attached images, each with a `✕` to remove (the line in the textarea is deleted).

### 3.2 File mode

The `promptFile` field gains an "Upload…" button and a drop zone:

- **Upload a `.md` file** (replaces the path field with its contents loaded into an inline editor — *out of scope for v1, see non-goal above*; for now we only support images).
- **Upload / paste / drop an image:** the file is written to `config/prompts/<agent-id>/assets/<timestamp>-<slug>.<ext>` on the server. The markdown file at `promptFile` is rewritten in place to append a reference:
  ```markdown
  ![diagram](assets/1719321733-diagram.png)
  ```
  The form shows a thumbnail of the saved image and the new line in the markdown.
- **Remove:** the asset file is deleted from disk and its line is removed from the markdown.

### 3.3 Shared affordances

- A "📎 N attachments" chip appears under whichever field has images.
- Empty state: dotted-border drop zone with the text "Paste, drop, or click to attach an image".
- Hover state: highlight the drop zone with `var(--accent)`.
- Disabled while saving (prevents double-submits).

---

## 4. Data model

### 4.1 Additive schema fields

In `src/core/schemas.ts`, extend `AgentConfigSchema`:

```ts
export const AssetRefSchema = z.object({
  filename: z.string().regex(/^[\w.-]+$/, "Invalid filename"),
  mime:     z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  size:     z.number().int().positive().max(5 * 1024 * 1024), // 5 MiB
  // data:    required only on POST. Server strips before persisting.
  data:     z.string().optional(),
});

export const AgentConfigSchema = z.object({
  // …existing fields…
  assets: z.array(AssetRefSchema).optional(),
});
```

The server **strips `data`** before persisting (the asset lives on disk, not in `panelists.json`). The form receives the asset's filename + a data URL **for the current session only** (rendered in the thumbnail); the asset file is the source of truth.

### 4.2 On-disk layout

```
config/
├── panelists.json
└── prompts/
    ├── security.md
    ├── quality.md
    └── security/
        └── assets/
            ├── 1719321733-login-screen.png
            └── 1719321810-error-state.png
```

Assets are colocated with the prompt that references them. The agent-id is the directory name so multiple panelists can each have their own asset folder without collisions.

### 4.3 Markdown reference format

In file mode, the server rewrites the markdown file:

```diff
  You are the Security Architect for this project.
  Review changes for: auth, injection, secrets, supply-chain.

+ ![login screen](assets/1719321733-login-screen.png)
+ ![error state](assets/1719321810-error-state.png)
```

A single trailing block, one image per line, in the order they were attached. Removing an image deletes the line and the file. Re-ordering is a future feature.

In inline mode, the data URL is embedded in the textarea text directly; no on-disk asset is created.

---

## 5. Backend changes

### 5.1 New endpoint — `POST /api/config/asset`

Multipart form upload, agent-id in the path or a field. Behaviour:

1. **Auth.** Same `COUNCIL_API_TOKEN` check as other config endpoints.
2. **Validate.**
   - `agentId` matches a current panelist (and not the judge/validator's id — those have no per-id folder; the asset goes to `config/prompts/judge/assets/` for them, same pattern).
   - File MIME in the allow-list above.
   - File size ≤ 5 MiB.
   - Original filename sanitised: replace anything outside `[A-Za-z0-9._-]` with `_`; prepend `<epochMs>-` to prevent collisions.
3. **Write.** `config/prompts/<agentId>/assets/<filename>` with `fs.writeFile`. `mkdirSync(..., { recursive: true })` if the folder is missing.
4. **Respond.** `{ ok: true, filename, url: "/api/config/asset/<agentId>/<filename>" }`. The URL is for the form to render the thumbnail without re-uploading.

### 5.2 New endpoint — `GET /api/config/asset/:agentId/:filename`

- Auth-gated.
- Stream the file with the correct `Content-Type`.
- Path-traversal guard: reject if the resolved path escapes `config/prompts/<agentId>/assets/`.
- 404 on miss.

### 5.3 New endpoint — `DELETE /api/config/asset/:agentId/:filename`

- Auth-gated.
- Removes the file and rewrites the referenced markdown to drop the line.
- Idempotent: missing file returns `{ ok: true }`, not 404.

### 5.4 `POST /api/config` extension

When the form posts a config with `assets: [{ filename, data, … }]`, the server:

1. Writes each `data` (base64) to disk under the appropriate `<agentId>/assets/<filename-safe>`.
2. Rewrites the agent's `promptFile` markdown to add a reference line.
3. **Strips `data` from the persisted JSON** — only `filename`, `mime`, `size` are stored.
4. Validates with `CouncilConfigSchema.parse` *after* writing the assets, so a partial save can't leave dangling references.

Atomicity: use a `tmp-<runId>` staging dir, validate, then `fs.rename` into place. If validation fails, `rm -rf` the staging dir.

### 5.5 Round-trip behaviour

- `GET /api/config` returns `assets: [{ filename, mime, size }]` for each agent.
- The form resolves each asset to a data URL for the current session by `fetch`-ing `GET /api/config/asset/<agentId>/<filename>` once on load (cached in component state, never sent back on save).
- Saving only sends `assets` for **new** attachments (with `data`); existing assets are passed through as-is and their `data` is `undefined`.

---

## 6. Frontend changes

### 6.1 New components (`src/ui/index.html`)

- `<AssetChip assets onRemove>` — small `📎 N` chip; click expands a thumbnail strip.
- `<Thumbnail src onRemove>` — single image with a `✕` overlay; `src` is either a data URL or the asset GET URL.
- `<DropZone onFiles>` — dashed-border area; fires on drag-over / drop / click-to-pick.
- `<TextareaWithPaste>` — wraps a `<textarea>`; intercepts `onPaste` for `image/*` clipboard items, intercepts `onDrop` for image files; delegates plain text pastes to the native handler.

### 6.2 `AgentForm` updates

- The inline `<textarea>` becomes `<TextareaWithPaste>` with an `<AssetChip>` underneath.
- The file-mode `promptFile` field gets a `Upload` button and a `<DropZone>` (paste + drop + click all wired to `POST /api/config/asset`).
- `onChange` is extended to accept an `assets` field in addition to the existing scalar fields.

### 6.3 `normalizeConfig` / `denormalizeConfig` updates

- `normalizeConfig` keeps `assets` as-is (it already serialises through the spread).
- `denormalizeConfig` adds `assets: form.assets` to the agent payload when present; never strips existing assets if the form has them.
- The `addPanelist` default no longer ships a `promptFile`; it ships no assets and an empty `systemPrompt`. The user can paste/type into either.

### 6.4 No new dependencies

The current UI uses React + Babel from a CDN. The image paste/drop logic is plain browser APIs (`ClipboardEvent`, `DataTransfer`, `FileReader.readAsDataURL`). No new package.

---

## 7. Security

| Risk | Mitigation |
|---|---|
| **Path traversal** in upload | Sanitise filename to `[\w.-]+`, prefix with `<epochMs>-`, resolve and assert the path is under `config/prompts/<agentId>/assets/`. |
| **SVG / HTML / JS** in uploads | MIME allow-list of `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Reject `image/svg+xml` (can contain JS). Reject any MIME starting with `text/`. |
| **MIME sniffing** (`foo.png` that is actually HTML) | Validate by sniffing the first 8 bytes (PNG / JFIF / GIF87a/89a / RIFF/WEBP). Reject on mismatch. |
| **Size DoS** | 5 MiB per file, 20 MiB per config save (sum of `assets[].size`). |
| **Stale references** if an asset is deleted out-of-band | On save, the server checks each `assets[].filename` exists; if not, it returns `400 { error: "Missing asset: …" }`. |
| **Markdown injection** (a `promptFile` line like `![](javascript:…)`) | We are not adding the asset URL to the prompt as an HTML tag — it's markdown, rendered by the agent CLI as text. The `javascript:` URL in markdown is treated as text by the agent, not a link. Document this in the panelist prompt guidelines. |
| **Auth bypass** on asset GET/DELETE | Same `COUNCIL_API_TOKEN` bearer check as `/api/config`. Loopback bind is the only protection when no token is set. |

---

## 8. Tests

Add to `tests/`:

- **`asset-api.test.ts`** — happy path upload, GET, DELETE; rejects oversize, bad MIME, bad filename, path-traversal attempt; verifies the markdown file is rewritten on upload and restored on delete.
- **`config-asset-roundtrip.test.ts`** — same pattern as `tests/form-roundtrip.test.ts` (added previously): simulate the form's denormalize output including `assets: [{ filename, data }]`, POST, verify the saved JSON has no `data` field and the file exists on disk.
- **Playwright** — paste a PNG into the inline textarea, assert the textarea value contains a `data:image/png;base64,…` line and a `📎 1 image` chip appears; click the chip, see the thumbnail; save the config, reload, see the thumbnail re-appear in file mode after re-resolving the asset URL.

---

## 9. Acceptance criteria

A reviewer can:

1. Open `http://localhost:3000/`, click the **Config** tab (now always visible — see prior fix).
2. In a panelist's inline system prompt, paste a screenshot from the clipboard; see the `📎 1 image` chip and a thumbnail; save the form.
3. Reload the page; the screenshot is still attached (rendered from a data URL or the asset endpoint) and the markdown file is unchanged.
4. Switch the same panelist to file mode, drop a second image; the file lands in `config/prompts/<id>/assets/`; the markdown file gains a reference line; the thumbnail is visible.
5. Click the `✕` on a thumbnail; the file is deleted from disk and the markdown line is gone.
6. `bun test` and `bun run typecheck` both pass.
7. A 6 MiB upload is rejected with a clear error. A `.svg` upload is rejected. A file named `../../etc/passwd` is rejected.

---

## 10. Out of scope (future)

- **Image-to-text (OCR)** preprocessing before sending to the panelist.
- **Inline previews** of the markdown file (currently shown as a path string).
- **Drag-to-reorder** assets in the chip.
- **Asset expiry / GC** for assets no longer referenced by any config.
- **Bulk upload** (zip or multi-select).
- **Versioning** of assets (they're plain files; git handles it).
