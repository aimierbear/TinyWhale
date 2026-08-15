# Local detach

Source: `github:omdsh-dev/DSH-better-sidebar#277e7d3b400310b84961cab41a8086acbd63a22a` (v0.12.0)

Reason (2026-08-14): upstream puts `margin-right: var(--dsh-sidebar-width)` on `#root`. TinyWhale's default window is 1280px; a 30% right panel shrinks the AppFrame below DSH's 1024px breakpoint and auto-collapses the left session list on every launch.

Change: squeeze only the center column (`#root > [data-slot=root] > frame > nth-child(2)`), same as the bottom panel. Files: `src/client/layout.css`, inlined copies in `lib/client.js` and `lib/client-registry.js`.

Change (2026-08-15): a fresh session opens Tasks first and Explorer second. A persisted factory layout that still has only one of those pages is upgraded on load. Files: `src/client/state.ts`, inlined copies in `lib/client.js` and `lib/client-registry.js`.

Do not click 更新 in the plugin market for this row — that would replace this directory with the upstream tarball and drop the patch. Re-apply from this folder if the profile is reinstalled.
