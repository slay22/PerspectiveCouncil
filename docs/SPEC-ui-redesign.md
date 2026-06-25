# Spec — Council UI Redesign (herdr.dev aesthetic)

> **Status:** Draft. Aesthetic reference: <https://herdr.dev>. Not a copy — borrow the vocabulary, not the page structure.
> **Scope:** `src/ui/index.html` only. No backend changes. No new deps.

---

## 1. Why

The current UI works but reads as a generic 2020-era dark dashboard: 12px card radii, big rounded buttons, emoji-as-icons, color-only status signaling. Two real costs:

- **Status is invisible without context.** `panelist.status === "running"` shows a spinner next to a colored card. You have to look at two places to know *what* is happening. Herdr renders state as a labelled chip — `● working · claude` — so the user reads it in one glance.
- **The form is editor-hostile.** The `promptFile` field is a bare text input with a placeholder. There's no visual indication of which file the agent will read, no way to copy the path, no way to see the prompt's content. Herdr treats paths and IDs as first-class command-card objects.

The herdr aesthetic solves both: small radii, mono font for code-shaped content, labelled status, command-card pattern for IDs/paths.

---

## 2. Goals & non-goals

### Goals

- **Light default, dark as a first-class option** (and the rest of herdr's 16-palette system is a freebie if we use CSS variables cleanly).
- **One glance to know each panelist's state** — chip with text (`● working`, `● done`, `● blocked`, `✕ error`), not a colored dot.
- **IDs and paths feel like shell commands** — monospace, in a card with a copy button. Not a label floating in space.
- **Section dividers that look like code comments** — `# panelists`, `# judge`, `# validator`, `# forge` in small mono.
- **No build step.** Same single-file React app, same CDN React/Babel. Just a deeper `:root` block and updated inline styles.
- **No new deps.** The whole redesign is CSS variables + a woff2 font preload.

### Non-goals

- Animations beyond a single subtle `transition: 120ms` on hover/active.
- Mobile-first responsive layout (council runs on a laptop with the GUI open in a side window; mobile is a future concern).
- Animated terminal mock of a running agent (herdr's hero has this; we don't have the pixel budget — a clean status chip is enough).
- Component extraction into separate files (out of scope; the single-file constraint is a feature, not a bug).

---

## 3. Theming system

Adopt herdr's `data-palette` pattern. `:root` carries the default; `[data-palette="..."]` blocks carry the alternates. The whole palette is one swap.

```css
:root {
  --bg:            #f0eee9;   /* warm cream */
  --bg-elevated:   #f5f3ee;   /* one step up — cards */
  --bg-sunken:     #e8e6e0;   /* one step down — code blocks */
  --ink:           #1a1a18;   /* primary text */
  --ink-soft:      #3a3a36;   /* body text */
  --muted:         #6b6b66;   /* secondary text */
  --muted-2:       #8a8a84;   /* tertiary / placeholder */
  --line:          #d8d6d0;   /* hairline borders */
  --line-strong:   #c4c2bb;   /* emphasised borders */
  --accent:        #4a9eff;   /* links, active nav */
  --accent-soft:   color-mix(in srgb, var(--accent) 10%, transparent);
  --green:         #2d9f52;   /* done */
  --yellow:        #b8860b;   /* working / pending */
  --red:           #c73e3e;   /* error / blocked */
  --purple:        #8b7ac9;   /* judge / validation */
  --radius-sm:     2px;
  --radius-md:     4px;
  --radius-lg:     6px;
  --max:           1160px;
  --mono:          "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --body:          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --term-bg:       #1a1d22;
  --term-text:     #c8cdd4;
  --term-prompt:   #4a9eff;
  --term-cmd:      #8ecf7a;
  --term-str:      #e6c060;
  --term-dim:      #6a7078;
  --term-blue:     #4a9eff;
  --term-green:    #7ecf8a;
}
@media (prefers-color-scheme: dark) {
  :root { /* Tokyo Night defaults */
    --bg: #1a1b26; --bg-elevated: #202331; --bg-sunken: #16161e;
    --ink: #d5dcff; --ink-soft: #c0caf5; --muted: #737aa2; --muted-2: #565f89;
    --line: #2f3549; --line-strong: #414868;
    --accent: #7aa2f7; --green: #9ece6a; --yellow: #e0af68; --red: #f7768e;
    --term-bg: #1a1b26; --term-text: #c0caf5; --term-prompt: #7aa2f7;
    --term-cmd: #9ece6a; --term-str: #e0af68; --term-dim: #565f89;
    --term-blue: #7aa2f7; --term-green: #9ece6a;
  }
}
```

**To swap palettes** (e.g. a user wants Catppuccin): add a `[data-palette="catppuccin"] { ... }` block. Same one-line `document.documentElement.dataset.palette = "catppuccin"` flip in JS as herdr uses. We ship light + dark for v1; the rest is "free if someone wants it."

---

## 4. Typography

| Role | Family | Size | Weight | Notes |
|---|---|---|---|---|
| Brand mark (logo) | `var(--mono)` | 16px | 700 | "⚖ perspective council" — all-mono lockup |
| Page H1 | `var(--body)` | 26px | 700 | 1.15 line-height |
| Section H2 | `var(--body)` | 17px | 700 | |
| Section kicker | `var(--mono)` | 11px | 500 | `# panelists`, `# judge` — uppercase, `letter-spacing: 0.08em`, `var(--muted)` |
| Body | `var(--body)` | 14px | 400 | 1.5 line-height |
| Field label | `var(--body)` | 11px | 500 | `var(--muted)`, uppercase, 0.06em tracking |
| Code / ID / path / status | `var(--mono)` | 12–13px | 400/500 | Always mono, never a label |

Load JetBrains Mono once at the top of `<head>`:

```html
<link rel="preload" href="https://fonts.bunny.net/jbm.woff2" as="font"
      type="font/woff2" crossorigin>
```

(Bunny Fonts is GDPR-clean, no Google tracking. Fallback: any CDN serving the woff2.)

---

## 5. Component vocabulary

### 5.1 `Card` (refactor existing)

```css
.card {
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);  /* was 12px — tighten to 6px */
  padding: 18px 20px;
}
.card-glow { box-shadow: 0 0 0 1px var(--accent-soft), 0 0 24px -8px var(--accent); }
```

### 5.2 `StatusChip` (new)

The single most important component. Replaces the current "spinner + check + X" emoji soup.

```jsx
const STATUS = {
  pending:  { color: "var(--muted)",    label: "○ pending",  dot: "○" },
  running:  { color: "var(--yellow)",   label: "● working",  dot: "●" },
  done:     { color: "var(--green)",    label: "✓ done",     dot: "✓" },
  error:    { color: "var(--red)",      label: "✕ error",    dot: "✕" },
  blocked:  { color: "var(--red)",      label: "◉ blocked",  dot: "◉" },
};
function StatusChip({ status, model }) {
  const s = STATUS[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "2px 8px", borderRadius: 4,
      background: s.color + "14",          /* 8% alpha */
      border: `1px solid ${s.color}40`,   /* 25% alpha */
      fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600,
      color: s.color, textTransform: "lowercase", letterSpacing: "0.02em",
    }}>
      <span style={{ fontSize: 10 }}>{s.dot}</span>
      {s.label}
      {model && <span style={{ color: "var(--muted)", marginLeft: 4 }}>· {model}</span>}
    </span>
  );
}
```

Renders as `● working · claude-opus-4-5` — readable in one glance, no color-only signaling.

### 5.3 `CommandCard` (new)

For IDs, paths, and CLI snippets. This is the herdr "install command" pattern shrunk to a form field.

```jsx
function CommandCard({ prompt, value, onCopy }) {
  return (
    <div style={{
      display: "flex", alignItems: "stretch",
      background: "var(--bg-sunken)",
      border: "1px solid var(--line)",
      borderRadius: "var(--radius-md)",
      fontFamily: "var(--mono)", fontSize: 12,
      overflow: "hidden",
    }}>
      <span style={{
        padding: "6px 10px", color: "var(--accent)",
        background: "var(--accent-soft)", borderRight: "1px solid var(--line)",
        fontWeight: 600, userSelect: "none",
      }}>{prompt}</span>
      <code style={{
        flex: 1, padding: "6px 10px", color: "var(--ink-soft)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{value}</code>
      <button onClick={onCopy} style={{
        padding: "6px 10px", background: "transparent",
        border: "none", borderLeft: "1px solid var(--line)",
        color: "var(--muted)", fontFamily: "var(--body)",
        fontSize: 11, fontWeight: 600, cursor: "pointer",
      }}>Copy</button>
    </div>
  );
}
```

Renders the ID field as:

```
$ id       security                                          Copy
```

And the `promptFile` field as:

```
$ prompt   ./prompts/security.md                             Copy
```

The Copy button writes to the clipboard and flashes `Copied` for 1.2s. (Browser Clipboard API; no deps.)

### 5.4 `Section` (new wrapper)

```jsx
function Section({ kicker, title, children, action }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 11, fontWeight: 500,
            color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em",
          }}># {kicker}</div>
          <h2 style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 700, color: "var(--ink)" }}>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
```

Renders as:

```
# PANELISTS
Panelists
[ ...cards... ]
```

### 5.5 Buttons (refactor)

Keep the same primary/secondary/danger pair but tighten radii and improve contrast:

```css
.btn { padding: 7px 14px; border-radius: var(--radius-md); font-weight: 600; font-size: 13px; transition: all 120ms; }
.btn-primary  { background: var(--ink); color: var(--bg); border: 1px solid var(--ink); }
.btn-secondary{ background: transparent; color: var(--ink); border: 1px solid var(--line-strong); }
.btn-danger   { background: transparent; color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); }
.btn:hover    { transform: translateY(-1px); }
.btn:active   { transform: translateY(0); }
```

The 1px lift on hover is the only animation. No `transition: all 200ms ease` on everything.

### 5.6 Inputs (refactor)

```css
.input, .textarea, .select {
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);  /* was 6px — tighten to 4px */
  padding: 7px 10px;
  font-size: 13px;
  color: var(--ink);
  font-family: var(--body);
  transition: border-color 120ms, box-shadow 120ms;
}
.input:focus, .textarea:focus, .select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.textarea { font-family: var(--mono); min-height: 120px; resize: vertical; }
```

The focus ring is `var(--accent-soft)` (10% alpha) — visible without screaming.

---

## 6. Page-by-page

### 6.1 Header (refactor)

- **Logo:** square 28px rounded-md block with `linear-gradient(135deg, var(--accent), var(--purple))` and `⚖` glyph. Wordmark in mono, lowercase, 14px, weight 700: `perspective council`.
- **Subtitle:** mono 11px, `var(--muted)`: `Run 7f3a… · /Users/…/council · main` (only when `state` is truthy).
- **Nav:** `Dashboard` / `New Run` / `Config` — same 3 tabs. Active tab: `var(--accent)` text + 1px bottom border in `var(--accent)`. Inactive: `var(--muted)`.
- **Live indicator:** small dot + `Live` / `Reconnecting…` in mono 11px.
- **Background:** `var(--bg-elevated)` with `border-bottom: 1px solid var(--line)`. No padding on the border.

### 6.2 Dashboard (refactor)

The stage pipeline gets a real visual treatment. Replace the current horizontal chevron bars with:

```
●─── worktrees ─── ● ── panel ── ● ── judge ── ● ── implement ── ○ ── validate ── ○ ── hil ── ○ ── pr ── ○ ── done
   done              running      future         future             future         future    future   future
```

Each stage:
- 6px dot, colored per status (`var(--green)` done, `var(--yellow)` running, `var(--muted)` future)
- 1px line connector, same color, dashed if future
- Stage name in mono 12px below
- Status text in 10px below the name

Panelist cards in a 3-column grid (or 2 on narrow):

```
┌──────────────────────────────────┐
│ 🔐 Security Architect     [chip] │
│ ───────────────────────────────  │
│ 3 key findings · risk: high      │
│                                  │
│  • finding 1                     │
│  • finding 2                     │
│  • finding 3                     │
│                                  │
│ > analysis text truncated…       │
└──────────────────────────────────┘
```

The `risk: high` is a coloured chip, not just a colour swatch. Key findings as a tight bulleted list with mono bullets.

The log gets a proper terminal treatment:

```
┌──────────────────────────────────────────────────────────┐
│ ▾ activity log                                           │
│ ──────────────────────────────────────────────────────── │
│ 10:42:13  info   security (claude) reading project spec… │
│ 10:42:14  info   security (claude) reading codebase…     │
│ 10:42:18  info   security analyzing (42k chars)…        │
│ ...                                                      │
└──────────────────────────────────────────────────────────┘
```

Background `var(--term-bg)`, text `var(--term-text)`, info level `var(--term-blue)`, error `var(--red)`, the timestamp in `var(--term-dim)`. Monospace, 12px, line-height 1.5. Looks like a real terminal tail.

### 6.3 Config tab (refactor)

The biggest change. The current form has every panelist as a flat `AgentForm` card with bare inputs. The redesign:

1. **Section kicker** `# PANELISTS` above the list. Add-panelist button to the right.
2. Each panelist becomes a `Section` with kicker `# PANELIST · <id>`, title `<icon> <label>`, and a body using `CommandCard` for `id` and `promptFile`.
3. **Inline mode** vs **file mode** is a segmented control, not radio buttons. Two pill buttons, active is filled:

   ```
   [ File path ]  [ Inline prompt ]
   ```

4. **Inline mode** is a `<textarea>` with mono font, focus ring, and a placeholder that actually shows an example: `You are a security reviewer. Focus on: …`.
5. **Add panelist** opens a small inline form (not a flat append); user types the id and label first, then the form expands.
6. **Remove** is a `✕` in the section header, not a full-width danger button at the bottom.

### 6.4 New Run form (refactor)

Two-column on wide viewports, single column below 900px. The "Existing repo" / "New project" toggle becomes a segmented control above the form. The textarea gets the focus ring. The "Start review" button is `btn-primary` and full-width on mobile.

### 6.5 Empty state

Currently shows the NewRunForm with no guidance. Add a one-line kicker above the form:

```
# START A RUN
Improve an existing repo, or build a new project from an idea.
```

(Two lines max. No marketing copy. The user came here to start a run, not to be sold to.)

---

## 7. Spacing & layout rules

- **Section vertical gap:** 24px.
- **Card internal padding:** 18px / 20px.
- **Field-to-field gap:** 12px (was 10px — slightly more breathing room).
- **Form row gap:** 12px.
- **Page max-width:** 960px (was full-bleed; herdr uses 1160px for marketing, but council is a working tool, not a sales page).
- **Page padding:** 28px horizontal on desktop, 16px on mobile (≤640px).
- **Header height:** 60px (currently floating with arbitrary padding).
- **Status chip line-height:** 1.

---

## 8. Accessibility

- All status states have a text label AND a colour — WCAG 1.4.1 (use of color) compliant by construction.
- Focus rings visible on every input, button, and selectable card.
- `prefers-reduced-motion` disables the 1px hover lift.
- The accent colour `#4a9eff` against `#f0eee9` has contrast 3.7:1 — under WCAG AA for large text and UI components but not for body. The dark variant `#7aa2f7` against `#1a1b26` has 7.2:1, full AAA. Document this in the palette spec; future iteration can darken the light accent if we need a stricter pass.
- All interactive elements are real `<button>` / `<a>` / `<input>`. The current emoji "buttons" (✓ ✕ ⚙) inside divs become `aria-label`'d `<button>`s.

---

## 9. Migration approach

Single file (`src/ui/index.html`), incremental, no risk to data:

1. **Phase A — variables only.** Add the `:root` block from §3 plus a `[data-palette="dark"]` block. Switch the existing inline-style colour references to the new var names. Light becomes the default. Existing dark users get an opt-in `?palette=dark` URL param.
2. **Phase B — components.** Add `StatusChip`, `CommandCard`, `Section`. Replace usages in `PanelistCard`, `AgentForm`, `NewRunForm`. One component at a time; the rest of the page keeps working.
3. **Phase C — page-by-page polish.** Header, stage pipeline, log, empty state. All using the new components.
4. **Phase D — copy + microcopy.** Tighten section labels, add the section kickers, prune the redundant helper text.

Each phase ships behind a `?ui=v2` URL flag for the first 2 weeks. Old UI is reachable via `?ui=v1` for rollback. After 2 weeks with no v1-specific issues filed, remove the v1 path.

---

## 10. Acceptance criteria

1. **Visual:** a screenshot of the new dashboard, side-by-side with herdr.dev's hero, would not look out of place in a "tools that take design seriously" roundup.
2. **Light by default.** `prefers-color-scheme: light` users get the cream palette on first load. Dark users get Tokyo Night.
3. **Status at a glance.** A panelist card shows `● working · claude-opus-4-5` in one chip. A non-sighted user with a screen reader hears "working, claude opus 4 5".
4. **ID is copyable.** The `id` field is a `CommandCard` with a Copy button. Clicking it copies `"security"` to the clipboard and flashes `Copied` for 1.2s.
5. **Path is copyable.** The `promptFile` field is a `CommandCard` with a Copy button. Clicking it copies `./prompts/security.md` to the clipboard.
6. **No new deps.** `package.json` is unchanged. `bun run typecheck` passes. All existing `bun test` tests pass.
7. **No new HTTP routes.** Backend is untouched.
8. **Performance.** No layout shift on first paint (font preload is in `<head>`, `font-display: swap`).
9. **Rollback works.** `?ui=v1` renders the current UI pixel-for-pixel.

---

## 11. Out of scope (future)

- **A second palette shipped by default** (Catppuccin, Nord, etc.). The infrastructure is in place after this spec; adding palettes is a 5-line CSS block.
- **A settings panel** for the palette picker. For now, `?palette=tokyo-night` URL param + a one-line `localStorage` setter in the inline script.
- **Per-run theming** (e.g. red theme for production runs, green for greenfield). Not useful yet.
- **Animated terminal hero on the empty state.** Tempting but expensive in pixel terms; revisit if the council ever gets a marketing surface.
- **Light/dark toggle in the header.** A `?palette=…` URL param is enough for v1; a toggle is a 1-day follow-up.

---

## Active/Inactive panelists (added 2026-06-25)

The Config editor lets users add as many panelists as they like and toggle each one `● active` / `○ inactive`. The behavior:

- **Inactive** panelists are kept in `panelists.json` (with `"active": false`) so the user can re-enable them later.
- The conductor filters out inactive panelists before `createWorktrees` and `runPanel` — they don't get a worktree, don't run, and don't appear in the live dashboard.
- A skip log line is emitted at run start: `Skipping inactive panelist: <label> (<id>)`.
- **At least 2 panelists must be active** to start a run. The constraint is enforced at three layers: the Zod schema's `.refine`, the `POST /api/config` handler (via the schema), and the `POST /api/run` handler (a safety net for hand-edited configs).
- The **Config tab is read-only** while a run is in flight (lock banner, disabled inputs, hidden Add/Remove/Picker/Upload). It unlocks when the run is `done` or `aborted`.
- The **New Run form** shows a warning card and disables "Start review" when the active count is < 2, with a "config tab" link to fix it.

In the UI:
- Inactive cards are visually de-emphasised (`opacity: 0.55`) but stay interactive.
- The `# PANELISTS` section kicker shows `N configured · M active`, turning red with "need ≥ 2 to run" when the active count is < 2.
- The "Remove" confirm message warns the user when removing would leave < 2 active.

**Known limitation:** no in-UI "Cancel run" button — the user must cancel via Telegram's `abort` decision or by killing the server process. Out of scope for this iteration; see PLAN.md Phase 5.
