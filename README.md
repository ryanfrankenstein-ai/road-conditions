# Along the way

A responsive family drive forecast for Spencer, Highway 71 and Storm Lake. The site is static: serve `index.html`, `styles.css` and `roads.json` together, or use GitHub Pages. No build step is needed.

## Family schedule

Edit `DRIVES`, `GAMES` and `TOWNS` near the top of the script in `index.html` to change routes, departure times or game travel. Empty game schedules display a friendly placeholder. Forecast ratings and data fetching are independent of the responsive styles in `styles.css`.

## Browser checks

Install development dependencies with `npm install`, then install a browser with `npx playwright install chromium`. Run `npm test`. To use an installed Edge browser instead, set `PLAYWRIGHT_CHANNEL=msedge` in your shell.

The checks use a fixed date and simulated NWS responses. They cover day selection, alerts, refresh, service outages and recovery, keyboard focus, horizontal overflow at seven widths from 320 to 1440 pixels, and control heights of at least 44 pixels. Sample desktop and phone screenshots are saved to `.test-artifacts/`; their weather is test data, not a live forecast.

The route illustration is schematic and is not a navigation map. Weather comes from NWS; the existing scheduled workflow refreshes Iowa 511 road reports.
