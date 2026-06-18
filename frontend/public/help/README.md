# GoWarmCRM Help Center — self-contained drop-in

Static, role-aware help. **Each HTML file is fully self-contained** — CSS and JS are
inlined, so there are no external asset files to resolve. Drop them anywhere and they
render identically (no build step, no dependency on `/assets/`, CSP-safe).

```
help/
  index.html          Role router + landing (#super-admin / #org-admin / #member)
  superadmin.html     Super Admin guide
  orgadmin.html       Org Admin guide
  enduser.html        End-User (Sales Rep) guide
  README.md           This file
```

## Drop-in (Create React App / Vercel)

Copy the folder to:

```
frontend/public/help/
```

CRA serves `public/` at the site root and copies it verbatim into `build/`, so it's
live at `https://app.gowarmcrm.com/help/` with no config. Because every page is
self-contained, there is nothing else to resolve — if the `.html` loads, it's styled.

## In-app entry

The sidebar "Help & Guides" button opens `/help/index.html#<role>`; the landing page
redirects by hash: `#super-admin` → superadmin, `#org-admin` → orgadmin, `#member`
→ enduser. Unknown slugs fall through to the landing page.

## Why self-contained?

An earlier version linked a shared `assets/help.css`. On some Vercel/CRA setups a
sub-path like `/help/assets/help.css` can be intercepted by the SPA fallback (it
returns `index.html`, which the browser won't apply as CSS) or simply 404 if the
folder isn't deployed — producing an unstyled page even though the HTML loads.
Inlining removes that failure mode entirely.

## Editing later

Each file has one `<style>` block near the top (the theme — Ember #E8630A / Navy
#1A3A5C) and, on the guide pages, one `<script>` block before `</body>` (nav,
search, mobile menu). The screen-maps are inline SVG keyed to the same palette.
