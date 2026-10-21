# Wishlist

A pretty wishlist you fill by pasting product links. Gallery and list views, tag filters, gold marks for limited editions, and a running total. Plain HTML, CSS and JavaScript, no build step, no backend. Deploys to GitHub Pages as-is.

## Run it locally

Open the folder in a terminal and start any static server, for example:

```sh
python3 -m http.server 8000
```

Then visit <http://localhost:8000>. Opening `index.html` straight from the file system also works, except that the example items in `wishlist.json` cannot be loaded that way.

## Deploy to GitHub Pages

1. Create an empty repository on GitHub, for example `wishlist`.
2. In this folder:

   ```sh
   git init
   git add .
   git commit -m "Wishlist site"
   git branch -M main
   git remote add origin https://github.com/<your-username>/wishlist.git
   git push -u origin main
   ```

3. On GitHub open **Settings → Pages**. Under **Build and deployment** pick **Deploy from a branch**, choose `main` and the `/ (root)` folder, then save.
4. After a minute the site is live at `https://<your-username>.github.io/wishlist/`.

Every later `git push` to `main` redeploys it.

## How it works

- **Adding a link.** The page fetches the store page through a public reader (Jina Reader first, allorigins as backup) and reads its Open Graph tags and schema.org Product data: name, brand, photo, price and currency. If that fails it asks Microlink for the title and photo. If everything fails, it falls back to a guess from the URL alone and you can edit the item by hand or attach a photo.
- **Photos.** Store photos are shown through the images.weserv.nl proxy, which trims the margins and pads every photo onto the same white 4:5 tile so products look a similar size. If the proxy fails the original loads, and only then does the colored placeholder show. Logos, icons and placeholder images are skipped. Photos you attach are trimmed the same way in the browser.
- **Stores that block readers** (Hermès, Chanel, Sephora, lululemon and others behind bot protection) cannot be fetched by any website. For those the name, brand and category are guessed from the link itself and the card shows "Add a photo": click it, then paste or drop a screenshot of the product.
- **Organizing.** Sort by newest, price, name, brand or category. "Group by tag" turns the list into sections per category, each with its own subtotal, and clicking a section heading rolls it up. The trash button on each item removes it after a second confirming tap.
- **Limited editions.** An item gets the gold mark when the link or the page text says limited edition, special edition, collector's edition, holiday edition, collaboration, capsule collection, or similar. You can also toggle it yourself in the edit panel.
- **Prices and currencies.** Each item keeps the price and currency the store listed (an EU store gives EUR, a UK store GBP). The **Show prices in** picker at the bottom converts everything, including the total, into one currency using European Central Bank reference rates from frankfurter.dev. Rates refresh every 12 hours and a snapshot is built in for offline use. Converted prices show the original underneath. A price guessed from page text rather than a price field is marked *est.*. Items marked "Got it" are struck through and left out of the total.
- **Budget.** Set a budget in the ledger. A bar shows how much of it the whole list (everything not yet marked got-it) uses, turning gold when you are over.
- **Theme.** The page is light by default. The moon button in the header switches to dark and the choice is remembered. Adding `?theme=dark` to the address also works.
- **Storage.** Items, budget and preferences are saved in the browser (localStorage), so they stay on the device they were added from. Use **Export JSON** to back up or move to another device, and **Import JSON** to load them there.
- **Photos you attach** are shrunk and stored inline. Browser storage holds roughly 5 MB, which is plenty for dozens of photos, but prefer the store's photo URL when the page could read it.

## Publish your list for others

Visitors see the committed `wishlist.json` the first time they open the site. To share your real list:

1. Click **Export JSON** on the site.
2. Rename the downloaded file to `wishlist.json`, replace the one in this folder, and push.

Visitors who already opened the site keep what their browser saved. They can click **Start over** to clear it and reload, or use **Import JSON** with your exported file.

## Limits worth knowing

- Some stores (Sephora, Ulta and others behind bot protection) refuse automated fetches. For those the page falls back to the URL guess; attach a screenshot or type the details.
- The readers are free public services with rate limits (Jina allows about 20 links a minute, Microlink about 25 a day) and no uptime promise. If link reading stops working, swap the entries in `READERS` at the top of `app.js` for a proxy you run yourself.
- Product photos are hot-linked from the store's own CDN, with the image proxy as a backup. If both fail, the item shows its colored placeholder; paste another photo URL in the edit panel or attach one.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `styles.css` | Theme (light and dark), layout, components |
| `app.js` | State, storage, link reading, rendering |
| `wishlist.json` | Seed list shown on a visitor's first visit |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
