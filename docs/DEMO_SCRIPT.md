# Screen recording — shot list

Target length **90 seconds**, hard ceiling two minutes. Save the result as
`docs/demo.mp4` (or upload it and put the link in the README's Live demo table).

## Before you hit record

1. **Wake the backend.** Open <https://grid-contigency-explorer.onrender.com/api/health>
   and wait for the JSON. If you record the cold start, forty of your ninety
   seconds are a spinner.
2. **Load the app once** at <https://grid-contingency-explorer.vercel.app/> and
   let the right panel finish, so the topology is cached in the API process.
3. **Then reload** and start recording on a clean, warm page.
4. Browser at **1600×1000 or wider**, zoom 100%. The layout is a three-column
   grid that collapses below 1100px — a narrow window records the mobile
   fallback, which is not the thing you want to show.
5. Close other tabs, hide bookmarks, full-screen the window.

## Shots

| # | Time | What you do | What you say |
|---|---|---|---|
| 1 | 0:00–0:10 | Sit on the loaded page. Move the cursor slowly across the map. | "This is the Indian bulk transmission grid — 112 substations, 230 corridors, 49 power stations and 60 cities, held in CognoDB as a graph." |
| 2 | 0:10–0:20 | Point at the legend, then at a thick purple line, then at the big circle on Delhi. | "Colour is voltage class, width is capacity, and the circles are cities sized by peak demand. Right now every city can be supplied." |
| 3 | 0:20–0:35 | Click **Mundra–Mohindergarh HVDC Bipole** in the left panel. Let the panels settle. | "I'll take out the Mundra–Mohindergarh HVDC link — one of the longest DC corridors in the country." |
| 4 | 0:35–0:48 | Cursor to the red **2,265** figure, then to Delhi turning red on the map. | "Delhi is now 2,265 megawatts short of its 8,000 megawatt peak — 32 million people. Nothing was precomputed; the outage is one query parameter and every route in the country re-planned." |
| 5 | 0:48–1:00 | Scroll the right panel to **Deliverable generation mix**. | "Its fuel mix changed too — coal falls from 41 to 36 percent, because the Gujarat coal reached Delhi over that link." |
| 6 | 1:00–1:15 | Keep scrolling to **Supply paths**. Hover one row so the route line is readable. | "And these are the surviving routes. Each row is a generator that can still reach Delhi: the hop count, the weakest corridor on the best route, and the route itself. That's a variable-length traversal — the reason this is a graph database and not a table." |
| 7 | 1:15–1:25 | Click **Restore all** in the header. Everything returns to normal. | "Restore it, and the network is adequate again." |
| 8 | 1:25–1:35 | Click **Ballabgarh–Bhiwadi 400kV** in the critical corridors list. | "One more — this single 400 kV line is the worst N‑1 outage in the whole network." |

## Do not

- Do not narrate the loading skeletons. If a panel is still loading, wait, then
  speak. Silence reads better than "it's just loading".
- Do not click a corridor directly on the map for the first trip. The click
  target is an 11px invisible stroke and a miss on camera looks like a bug —
  use the left panel list, which is a plain button. Save the map click for shot
  8 if you want to show it.
- Do not open DevTools.

## If you want to show the error state too

Worth ten seconds if you have room, because graceful failure is explicitly
marked in the brief. Run the frontend locally against a dead API:

```bash
cd frontend
NEXT_PUBLIC_API_BASE=http://localhost:9999 npm run dev
```

The page renders the "Database unreachable" banner with a working **Retry**.
Say: "And if the database is unreachable, the UI says exactly that and offers a
retry, rather than failing silently."
