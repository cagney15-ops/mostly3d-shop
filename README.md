# Mostly 3D shop

Products, filament rack, costing, activity log, reorder list and barcode labels for the Mostly 3D shop, as one live site that works on an iPad, a phone or a laptop. The data lives in Supabase (Postgres + Auth + Storage); the site is static and hosted on Vercel, so every push to `main` deploys.

## What is in the folder

| File | What it is |
| --- | --- |
| `index.html` | The page: markup and all styling (the 812 Sensory format: white paper, black ink, heart red). |
| `app.js` | The whole app: sign-in, loading and saving to Supabase, costing math, scanning, labels. No build step, plain ES modules. |
| `catalog.js` | Every Bambu Lab PLA color with its line and display hex. |
| `config.js` | The Supabase project URL and anon key. The anon key is public by design; row-level security in the database decides who can read or write. |
| `manifest.webmanifest`, `icon-*.png` | Lets the site be added to an iPad home screen as an app. |
| `vercel.json` | Hosting settings (clean URLs, cache headers). |

## How it fits together

The page is split into tabs: **Home** (summary, needs-attention list, recent activity, reorder list), **Products**, **Filament** (rack and color wall), **Parts & accessories**, **Activity**, **Labels**, **Settings**. The scan bar sits above every tab.

- **Customize your shop** (Settings, and automatically on a fresh install): shop name, script line, letterspaced line and logo; what you make (3D printing or another maker shop); and which modules show on screen. The *What shows on screen* sheet under Settings switches any module off later: parts, playsets, color wall, usage charts, labels, energy, finishing labor, packaging, activity. Switched-off cost modules drop out of the per-unit cost.
- **Changes log**: every create, edit (field by field), delete, settings change, color swap and label print is recorded with who did it. Activity has a Stock moves / Changes switch with filters by person, date range and search; Settings lists people with what they created. Detail panels show created / last edited lines.
- **Adjust…** replaces a raw count with a reason (miscount, damaged, gift, returned, lost…) and a note, on products, spools and parts.
- **Stock levels**: minimum and maximum per item (editor, or the ⋯ menu → Stock levels). The reorder list tops up to the maximum when one is set.
- **⋯ menu** on every product card, spool and part row: open, edit, adjust, levels, print this label, archive / take off the rack.
- **Labels**: tick what to print; *Never printed* and *Low stock* filters; printing stamps the items so new products never mean reprinting old ones.
- **Replace a color** (Filament tab): swap one spool for another across every product recipe in one go.
- **Print files**: 3MF / G-code / STL on each product, downloadable with a signed link or opened straight in Bambu Studio / OrcaSlicer from the detail panel.
- **Sign in** is Supabase Auth, email and password. Anyone can create an account, but only emails on the `allowed_users` list can see or change anything (enforced in the database, not just the page). Add or remove people under Settings.
- **Products** carry a photo and the slicer's filament table: for each color, *Model / Purged / Tower* grams for the whole plate, plus how many units are on the plate and the plate's print time. Everything is divided by the unit count, each color's purge and tower are charged at that color's own price, and the cost per unit is live at your current spool prices. "Single item" is a plate of one. "Made N" pulls N units' worth of filament off the rack (purge and tower included) and adds N to the shelf; "Sold N" takes N off. Both land in Activity and can be undone.
- **Playsets** bundle products: "Create playset", pick the products and quantities, and the set's cost is their unit costs added up (plus the set's own packaging or finishing). "Assembled N" takes the parts off their shelves and puts N sets on the playset's shelf. A playset can contain another playset.
- **Parts & accessories** is a scannable inventory for everything that is not filament or a product: nozzles, hotends, plates, belts, tools, consumables. Add your printers once (the Printers button), then tie each part to the printers it fits; untagged parts fit anything. The list filters by printer and by type, has quick +/− buttons, and every part gets a printable `M3D-A-…` label. Scanning a part in Receive mode adds stock; in Made or Sold mode it records the part as used; an unknown package barcode can become a new part on the spot.
- **Tap anything to expand it.** A product card, a spool on the rack, or a part row opens a detail panel in place: the facts (cost, price and margin, print time, filament per unit, on hand and how many weeks that lasts at the current pace), the colors or parts it is made of, quick Made/Sold or Received/Used buttons, and a usage chart of the last 12 weeks (made and sold per week for products; grams pulled per week for spools; pieces used per week for parts). Edit opens the full editor.
- **Rack** is every spool you own: rolls on hand and grams left on the open roll. Spools under their reorder point turn red and go on the Reorder list.
- **Color wall** is every Bambu PLA color. The price in each line's header is what you pay per roll for that whole line; a spool can have its own price instead.
- **Scan bar** takes a Bluetooth barcode scanner (it types like a keyboard) or a code typed by hand. The mode decides what a scan does: Receive, Made, Sold or Look up, times the quantity. Internal labels (`M3D-S-…` for spools, the SKU for products) print from the Labels section. Bambu boxes already carry a barcode; the first scan of a new one asks which color it is and remembers it.
- **Live sync**: every open copy of the page updates within a second or two when someone else changes something.

## Running it

Nothing to install. Open the Vercel URL and sign in. To run a copy locally, serve the folder with any static server (for example `python3 -m http.server 8080`) and open `http://localhost:8080`; it talks to the same database.

## Deploying

Vercel is connected to this repository: pushing to `main` deploys production. There is no build command; the folder is served as is.

## Supabase

Project `mkwthdcpafpmxwpdgbov`. Tables: `allowed_users`, `shop_settings`, `spools`, `gtin_map`, `products`, `product_filaments`, `product_components`, `product_files`, `parts`, `printers`, `part_printers`, `movements`, `audit_log`; storage buckets `product-photos` (public) and `product-files` (private, signed links). All tables have row-level security that allows access only when `is_allowed()` is true for the signed-in email.

In the Supabase dashboard, under Authentication → URL Configuration, the Site URL and Redirect URLs should be the site's address so password-reset and sign-up confirmation links come back to the app.

## Scanner tips

- Any Bluetooth scanner in HID (keyboard) mode works. On an iPad, pair it under Settings → Bluetooth. Most scanners have a button or a config barcode to show or hide the iPad's on-screen keyboard while paired.
- Scans work from anywhere on the page; nothing has to be focused first. Set the mode and quantity before scanning a batch.
- Labels print three to a row on Letter paper from the Labels section; Avery 5160-style sheets or a plain sheet cut up both work.
