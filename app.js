/* Wishlist — static, no build step, no backend.
   Items live in this browser's localStorage. Export/Import moves them between devices.
   A committed wishlist.json seeds the list on a visitor's first visit.
   Link reading: the store page is fetched through a public reader (Jina, then allorigins) and its
   Open Graph / schema.org Product metadata is parsed (name, brand, photo, price, currency).
   Microlink is the fallback. Prices are shown in one display currency using ECB rates. */
(() => {
'use strict';

/* ---------- config ---------- */
// Page readers, tried in order. Each must return the raw HTML of the store page with CORS allowed.
const READERS = [
  { url: u => 'https://r.jina.ai/' + u, headers: { 'X-Return-Format': 'html' }, timeout: 25000 },
  { url: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, timeout: 12000 },
];
// Fallback metadata API (free tier, no key). Returns title, description, image, publisher.
const MICROLINK = u => `https://api.microlink.io/?url=${encodeURIComponent(u)}`;
// Store photos load through an image proxy that shrinks them, flattens transparency to white and
// allows cross-origin reading, so the page can measure the product and reframe it (see wlFit).
// If the proxy fails, the original loads untouched.
const IMG_FIT = u => `https://images.weserv.nl/?url=${encodeURIComponent(u)}&w=900&h=1100&fit=inside&we&bg=ffffff&q=85&output=jpg`;
// Every photo is redrawn onto the same 4:5 white tile with the product centered and scaled so its
// bounding box covers about `area` of the tile, never exceeding `max` of either side. Matching area
// rather than height makes a thin tube and a wide ring look the same size.
const TILE = { w: 720, h: 900, area: 0.30, max: 0.80 };
// Exchange rates (European Central Bank reference rates, USD base).
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';
const RATES_FALLBACK = { date: '2026-10-15', fetchedAt: 0, rates: {"AUD":1.447,"BRL":5.057,"CAD":1.4207,"CHF":0.83021,"CNY":6.691,"CZK":21.728,"DKK":6.6693,"EUR":0.89222,"GBP":0.75491,"HKD":7.8473,"HUF":324.41,"IDR":17944,"ILS":3.1022,"INR":95.06,"ISK":121.7,"JPY":157.98,"KRW":1345.9,"MXN":18.5225,"MYR":4.0825,"NOK":9.5039,"NZD":1.7855,"PHP":63.074,"PLN":3.899,"RON":4.7588,"SEK":9.9719,"SGD":1.2829,"THB":33.54,"TRY":49.417,"ZAR":16.5568} };
const RATES_MAX_AGE = 12 * 60 * 60 * 1000;
const SEED_FILE = 'wishlist.json';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const TAG_SET = ['beauty','skincare','makeup','fragrance','hair','wellness','fitness','fashion','shoes','bags','jewelry','accessories','home','tech','books','food','travel','kids','other'];

const state = { items: [], view: 'gallery', filter: 'all', sort: 'newest', group: false, hideGot: false, editing: null, draftImage: null, displayCur: 'USD', budget: null, theme: 'light', collapsed: [] };

/* ---------- prefs + storage (this browser) ---------- */
const store = {
  get(k, d){ try { const v = localStorage.getItem('wl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem('wl.' + k, JSON.stringify(v)); return true; } catch { return false; } },
  has(k){ try { return localStorage.getItem('wl.' + k) != null; } catch { return false; } },
};
state.view = store.get('view', 'gallery'); state.sort = store.get('sort', 'newest'); state.group = store.get('group', false); state.hideGot = store.get('hideGot', false);
state.displayCur = store.get('displayCur', 'USD'); state.budget = store.get('budget', null); state.theme = store.get('theme', 'light');
state.collapsed = (store.get('collapsed', []) || []).filter(x => typeof x === 'string');

function persist(){
  if (!store.set('items', state.items)) toast('Could not save: this browser\u2019s storage is full. Export your list, then remove some photos.');
}
function saveItem(item){
  const i = state.items.findIndex(x => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.unshift(item);
  persist(); render();
}
function deleteItem(id){ state.items = state.items.filter(x => x.id !== id); persist(); render(); }
function sanitizeItem(raw){
  if (!raw || typeof raw !== 'object') return null;
  const it = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    url: typeof raw.url === 'string' ? raw.url : '',
    name: String(raw.name || 'Untitled').slice(0, 120),
    brand: String(raw.brand || '').slice(0, 60),
    price: typeof raw.price === 'number' && isFinite(raw.price) ? raw.price : null,
    priceGuess: !!raw.priceGuess,
    currency: typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : 'USD',
    tags: Array.isArray(raw.tags) ? raw.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5) : ['other'],
    limited: !!raw.limited,
    limitedNote: typeof raw.limitedNote === 'string' ? raw.limitedNote.slice(0, 120) : undefined,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : undefined,
    image: typeof raw.image === 'string' && /^https?:\/\//i.test(raw.image) ? raw.image : undefined,
    imageData: typeof raw.imageData === 'string' && raw.imageData.startsWith('data:image/') ? raw.imageData : undefined,
    color: typeof raw.color === 'number' ? raw.color : hue(raw.brand || raw.url || ''),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    got: !!raw.got,
    example: !!raw.example,
    status: 'ready',
  };
  if (!it.tags.length) it.tags = ['other'];
  return it;
}

/* ---------- theme ---------- */
function applyTheme(t){
  state.theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  store.set('theme', state.theme);
}

/* ---------- currencies ---------- */
let fx = store.get('rates', null);
if (!fx || !fx.rates) fx = RATES_FALLBACK;
const CUR_FIRST = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF'];
function currencyList(){ const all = new Set(['USD', ...Object.keys(fx.rates)]); return [...CUR_FIRST.filter(c => all.has(c)), ...[...all].filter(c => !CUR_FIRST.includes(c)).sort()]; }
const rateOf = c => c === 'USD' ? 1 : (fx.rates[c] || null);
// Convert between currencies; returns null when a rate is missing.
function convert(amount, from, to){
  if (from === to) return amount;
  const rf = rateOf(from), rt = rateOf(to);
  if (!rf || !rt) return null;
  return amount / rf * rt;
}
function money(n, cur = state.displayCur){
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2, maximumFractionDigits: 2 }).format(n); }
  catch { return cur + ' ' + n.toFixed(2); }
}
// An item's price in the display currency, or null when unknown / not convertible.
function shown(i){
  if (typeof i.price !== 'number') return null;
  return convert(i.price, i.currency || 'USD', state.displayCur);
}
async function loadRates(){
  if (fx.fetchedAt && Date.now() - fx.fetchedAt < RATES_MAX_AGE) return;
  try {
    const r = await fetch(RATES_URL); if (!r.ok) return;
    const j = await r.json(); if (!j || !j.rates) return;
    fx = { date: j.date, rates: j.rates, fetchedAt: Date.now() }; store.set('rates', fx);
    fillCurrencySelects(); render();
  } catch {}
}
function fillCurrencySelects(){
  const opts = currencyList().map(c => `<option value="${c}">${c}</option>`).join('');
  const d = $('#displayCur'), f = $('#fCurrency');
  const fv = f.value;
  d.innerHTML = opts; f.innerHTML = opts;
  d.value = currencyList().includes(state.displayCur) ? state.displayCur : 'USD';
  if (fv) f.value = fv;
}

/* ---------- images ---------- */
function loadImage(blob){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    img.src = url;
  });
}
function draw(src, w, h){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(src, 0, 0, w, h);
  return c;
}
// Crop away the plain background around a product photo so attached photos frame like store ones.
function trimCanvas(c){
  const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const bg = [d[0], d[1], d[2]];
  const isBg = i => { const r = d[i], g = d[i + 1], b = d[i + 2]; return (r > 232 && g > 232 && b > 232) || Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 36; };
  const rowBg = y => { for (let x = 0; x < w; x++) if (!isBg((y * w + x) * 4)) return false; return true; };
  const colBg = (x, t, b) => { for (let y = t; y <= b; y++) if (!isBg((y * w + x) * 4)) return false; return true; };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowBg(top)) top++;
  while (bottom > top && rowBg(bottom)) bottom--;
  while (left < right && colBg(left, top, bottom)) left++;
  while (right > left && colBg(right, top, bottom)) right--;
  const cw = right - left + 1, ch = bottom - top + 1;
  if (cw < 24 || ch < 24 || (cw >= w - 2 && ch >= h - 2)) return c;
  const pad = Math.round(Math.max(cw, ch) * 0.08);
  const sx = Math.max(0, left - pad), sy = Math.max(0, top - pad), sw = Math.min(w - sx, cw + pad * 2), sh = Math.min(h - sy, ch + pad * 2);
  const o = document.createElement('canvas'); o.width = sw; o.height = sh;
  const x = o.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, sw, sh); x.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
  return o;
}
async function prepPhoto(blob){
  const img = await loadImage(blob);
  let s = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  let c = draw(img, Math.max(1, Math.round(img.naturalWidth * s)), Math.max(1, Math.round(img.naturalHeight * s)));
  try { c = trimCanvas(c); } catch {}
  s = Math.min(1, 800 / Math.max(c.width, c.height));
  if (s < 1) c = draw(c, Math.round(c.width * s), Math.round(c.height * s));
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.82));
}
const toDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
// Photos the user attaches are trimmed, shrunk and stored inline so a few dozen fit in localStorage.
async function storeImage(blob){
  try { const small = await prepPhoto(blob); return { imageData: await toDataURL(small), image: undefined }; }
  catch { toast('Could not read that image.'); return {}; }
}
const imgSrc = i => i.imageData || i.image || null;
// Store photos: skip placeholders and logos, force https (GitHub Pages is https, so http images would be blocked).
const BAD_IMG_RX = /no-image|noimage|placeholder|default-image|spacer|blank\.|\.gif(\?|$)|\.svg(\?|$)|opengraph-\d+x\d+|logo|favicon|icon-|brand-?mark|sprite|share-image|og-default|social-?(share|default|image)/i;
function pickImage(cands){
  for (let c of cands) {
    if (!c || typeof c !== 'string') continue;
    c = c.trim().replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(c) || BAD_IMG_RX.test(c)) continue;
    return c;
  }
  return '';
}
// Bounding box of the non-background pixels (background = near-white or the corner color).
function bbox(d, w, h){
  const corner = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const cs = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)];
  const bg = [0, 1, 2].map(k => Math.round(cs.reduce((s, c) => s + c[k], 0) / 4));
  const isBg = i => { const r = d[i], g = d[i + 1], b = d[i + 2]; return (r > 232 && g > 232 && b > 232) || Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 36; };
  const rowBg = y => { for (let x = 0; x < w; x++) if (!isBg((y * w + x) * 4)) return false; return true; };
  const colBg = (x, t, b) => { for (let y = t; y <= b; y++) if (!isBg((y * w + x) * 4)) return false; return true; };
  let t = 0, b = h - 1, l = 0, r = w - 1;
  while (t < b && rowBg(t)) t++;
  while (b > t && rowBg(b)) b--;
  while (l < r && colBg(l, t, b)) l++;
  while (r > l && colBg(r, t, b)) r--;
  return { l, t, r, b };
}
// Redraw a loaded photo onto the standard tile: product found, centered, scaled to TILE.fill.
// Needs pixel access, so it works for proxied and attached photos and is skipped for the raw fallback.
const fitCache = new Map();
window.wlFit = function(img){
  if (img.dataset.fitted) return;
  const key = img.dataset.src || img.src;
  const hit = fitCache.get(key);
  if (hit) { img.dataset.fitted = '1'; img.src = hit; return; }
  try {
    const iw = img.naturalWidth, ih = img.naturalHeight; if (!iw || !ih) return;
    const s0 = Math.min(1, 500 / Math.max(iw, ih));
    const small = draw(img, Math.max(1, Math.round(iw * s0)), Math.max(1, Math.round(ih * s0)));
    const bb = bbox(small.getContext('2d').getImageData(0, 0, small.width, small.height).data, small.width, small.height);
    let bw = bb.r - bb.l + 1, bh = bb.b - bb.t + 1;
    if (bw < 8 || bh < 8) { bb.l = 0; bb.t = 0; bw = small.width; bh = small.height; }
    // Scale to the target area, capped so neither side exceeds TILE.max, without blowing up a tiny source.
    let scale = Math.sqrt(TILE.w * TILE.h * TILE.area / (bw * bh));
    scale = Math.min(scale, TILE.w * TILE.max / bw, TILE.h * TILE.max / bh, 1.6 / s0);
    const dw = bw * scale, dh = bh * scale;
    const o = document.createElement('canvas'); o.width = TILE.w; o.height = TILE.h;
    const x = o.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, TILE.w, TILE.h); x.imageSmoothingQuality = 'high';
    x.drawImage(img, bb.l / s0, bb.t / s0, bw / s0, bh / s0, (TILE.w - dw) / 2, (TILE.h - dh) / 2, dw, dh);
    const url = o.toDataURL('image/jpeg', 0.86);
    fitCache.set(key, url); img.dataset.fitted = '1'; img.src = url;
  } catch { img.dataset.fitted = '1'; }
};
// Called from the img tag. Stage 0 is the proxy copy; a failure falls back to the original store
// URL (without cross-origin reading, so it cannot be reframed); a second failure hides the photo.
window.wlImgErr = function(img){
  const orig = img.dataset.src;
  if (orig && img.dataset.stage === '0' && /^https?:\/\//i.test(orig)) { img.dataset.stage = '1'; img.removeAttribute('crossorigin'); img.src = orig; return; }
  img.style.display = 'none';
};
window.wlImgOk = function(img){
  if (img.dataset.fitted) return;
  // A loaded picture smaller than an icon is a logo or tracking pixel, not a product photo.
  if (img.naturalWidth < 120 || img.naturalHeight < 120) { window.wlImgErr(img); return; }
  window.wlFit(img);
};
function imgTag(src, lazy){
  const l = lazy ? 'loading="lazy"' : '';
  if (!/^https?:\/\//i.test(src)) return `<img src="${esc(src)}" alt="" ${l} onerror="this.style.display='none'" onload="wlImgOk(this)">`;
  return `<img src="${esc(IMG_FIT(src))}" data-src="${esc(src)}" data-stage="0" crossorigin="anonymous" alt="" ${l} referrerpolicy="no-referrer" onerror="wlImgErr(this)" onload="wlImgOk(this)">`;
}

/* ---------- link heuristics (instant guess) ---------- */
const BRANDS = {sephora:'Sephora',ulta:'Ulta Beauty',glossier:'Glossier',rhodeskin:'rhode',ouraring:'Oura',amazon:'Amazon',nordstrom:'Nordstrom',aritzia:'Aritzia',zara:'Zara',lululemon:'lululemon',apple:'Apple',diptyqueparis:'Diptyque',charlottetilbury:'Charlotte Tilbury',rarebeauty:'Rare Beauty',summerfridays:'Summer Fridays',skims:'SKIMS',mejuri:'Mejuri',revolve:'Revolve',ssense:'SSENSE',netaporter:'Net-a-Porter',farfetch:'Farfetch',anthropologie:'Anthropologie',freepeople:'Free People',urbanoutfitters:'Urban Outfitters',target:'Target',etsy:'Etsy',shopbop:'Shopbop',saksfifthavenue:'Saks',bloomingdales:"Bloomingdale's",lelabofragrances:'Le Labo',byredo:'Byredo',aesop:'Aesop',drunkelephant:'Drunk Elephant',tatcha:'Tatcha',kosas:'Kosas',iliabeauty:'ILIA',meritbeauty:'MERIT',saiehello:'Saie',hourglasscosmetics:'Hourglass',patmcgrath:'Pat McGrath Labs',fentybeauty:'Fenty Beauty',youthtothepeople:'Youth To The People',stanley1913:'Stanley',dyson:'Dyson',fromourplace:'Our Place',parachutehome:'Parachute',brooklinen:'Brooklinen',jcrew:'J.Crew',madewell:'Madewell',everlane:'Everlane',thereformation:'Reformation',ganni:'GANNI',toteme:'Toteme',newbalance:'New Balance',nike:'Nike',adidas:'adidas',hoka:'HOKA',aloyoga:'Alo',vuori:'Vuori',setactive:'SET Active',therabody:'Therabody',whoop:'WHOOP',bookshop:'Bookshop',barnesandnoble:'Barnes & Noble',goop:'goop',violetgrey:'Violet Grey',cultbeauty:'Cult Beauty',spacenk:'Space NK',dermstore:'Dermstore',credobeauty:'Credo',bluemercury:'Bluemercury',glowrecipe:'Glow Recipe',laneige:'LANEIGE',soldejaneiro:'Sol de Janeiro',ouai:'OUAI',dieuxskin:'Dieux',augustinusbader:'Augustinus Bader',westmanatelier:'Westman Atelier',hermes:'Hermès',chanel:'CHANEL',dior:'Dior',louisvuitton:'Louis Vuitton',gucci:'Gucci',prada:'Prada',celine:'CELINE',ysl:'Saint Laurent',bottegaveneta:'Bottega Veneta',loewe:'LOEWE',miumiu:'Miu Miu',cartier:'Cartier',tiffany:'Tiffany & Co.',vancleefarpels:'Van Cleef & Arpels',burberry:'Burberry',balenciaga:'Balenciaga',fendi:'FENDI',valentino:'Valentino',givenchy:'Givenchy',jacquemus:'Jacquemus',coach:'Coach',polene:'Polène',maisonmargiela:'Maison Margiela',therow:'The Row',khaite:'KHAITE',mytheresa:'Mytheresa',matchesfashion:'MATCHES',luisaviaroma:'LuisaViaRoma'};
const TAG_RULES = [
  ['fragrance', /perfume|fragrance|parfum|eau de|eau-de|cologne|lelabo|byredo|diptyque/i],
  ['skincare', /skincare|skin care|serum|moisturi|cleanser|\bspf\b|sunscreen|retinol|toner|face mask|face-mask|sheet mask|eye cream|eye-cream|peptide|drunkelephant|tatcha|aesop|youthtothepeople|glowrecipe|laneige|dieux|augustinusbader|dermstore/i],
  ['makeup', /lipstick|lip gloss|lip-gloss|lip oil|lip-oil|lip tint|lip-tint|blush|mascara|makeup|foundation|concealer|palette|eyeshadow|brow|lash|highlighter|bronzer|charlottetilbury|rarebeauty|kosas|ilia|merit|saie|fenty|hourglass|patmcgrath|westman/i],
  ['hair', /\bhair|shampoo|conditioner|dyson-air|airwrap|ouai|scalp/i],
  ['beauty', /sephora|ulta|glossier|rhode|cosmetic|beauty|cultbeauty|spacenk|violetgrey|bluemercury|credo/i],
  ['wellness', /wellness|supplement|magnesium|collagen|protein|oura|whoop|sleep|meditat|journal|matcha|pilates|massage|therabody|sauna|vitamin|goop|candle/i],
  ['fitness', /fitness|\bgym\b|workout|running|trainer|dumbbell|lululemon|aloyoga|vuori|setactive|nike|hoka|newbalance|adidas|legging|sports bra|sports-bra/i],
  ['shoes', /shoe|sneaker|\bboot|loafer|heel|sandal|\bmule|ballet flat|ballet-flat/i],
  ['bags', /\bbag\b|tote|purse|clutch|wallet|crossbody|backpack/i],
  ['jewelry', /jewel|necklace|earring|bracelet|\bhoop|pendant|mejuri|\bring\b/i],
  ['fashion', /dress|jacket|coat|skirt|jeans|denim|blouse|sweater|cardigan|knit|trouser|\bpant|scarf|belt|sunglass|aritzia|zara|reformation|ganni|toteme|revolve|ssense|everlane|madewell|jcrew|skims|netaporter|farfetch|anthropologie|freepeople|hermes|chanel|\bdior|louisvuitton|gucci|prada|celine|bottegaveneta|loewe|miumiu|burberry|balenciaga|fendi|valentino|givenchy|jacquemus|margiela|therow|khaite|mytheresa|matchesfashion|luisaviaroma/i],
  ['home', /\bhome\b|decor|vase|pillow|bedding|sheet set|sheet-set|towel|kitchen|cookware|ourplace|parachute|brooklinen|lamp|\bmug\b|glassware|stanley/i],
  ['tech', /apple|airpods|iphone|ipad|kindle|headphone|speaker|camera|dyson|tech|smartwatch/i],
  ['books', /\bbook|novel|bookshop|barnesandnoble|paperback|hardcover/i],
];
// Loose test for URL slugs, strict test for page text (marketing copy says "holiday" a lot).
const LIMITED_SLUG_RX = /limited|special-edition|collector|anniversary|collab|capsule|holiday-edition|exclusive/i;
const LIMITED_TEXT_RX = /limited[\s-]edition|limited[\s-]release|limited[\s-]run|special[\s-]edition|collector'?s?[\s-]edition|holiday[\s-]edition|anniversary[\s-]edition|exclusive[\s-]edition|while supplies last|limited quantities|limited time only|capsule collection|\bcollab(?:oration)?\b|\bone[\s-]time (?:release|drop)\b/i;
const BLOCKED_RX = /access denied|forbidden|robot|captcha|just a moment|attention required|are you a human|blocked|verify you|secure access|really you|unusual|too many requests|\b404\b|not found|introuvable|page unavailable|service unavailable/i;

function parseUrl(raw){
  let s = String(raw || '').trim(); if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return /\./.test(u.hostname) ? u : null; } catch { return null; }
}
function brandFromHost(host){
  const parts = host.replace(/^www\./, '').split('.');
  let label = parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
  label = label || parts[0];
  const key = label.toLowerCase().replace(/-/g, '');
  return BRANDS[key] || BRANDS[label.toLowerCase()] || label.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function tagsFor(text){
  const tags = TAG_RULES.filter(([, rx]) => rx.test(text)).map(([t]) => t).slice(0, 3);
  return tags.length ? tags : ['other'];
}
function guessFromUrl(u){
  const host = u.hostname.toLowerCase();
  // Keep path segments that read like a product slug; drop locale codes, section words and bare ids
  // ("120210", "prod5020054", "H021056Z02350") but keep slugs that merely end in a code.
  const SECTION_RX = /^(p|pd|product|products|dp|item|items|shop|en|us|uk|ca|fr|de|it|es|jp|en[-_][a-z]{2}|[a-z]{2}[-_][a-z]{2}|collections|c|s|b|women|men|womens|mens|new|sale)$/i;
  const idLike = x => !x.includes('-') && (/^\d+$/.test(x) || (/\d/.test(x) && x.length >= 6) || /^[0-9a-f]{12,}$/i.test(x));
  const segs = u.pathname.split('/').map(x => { try { return decodeURIComponent(x); } catch { return x; } }).filter(x => x && !SECTION_RX.test(x) && !idLike(x));
  // The product slug is normally the last hyphenated segment ("…/jackets/Define-Jacket/_/prod5020054").
  const hyph = segs.filter(x => x.includes('-'));
  const slug = hyph.length ? hyph[hyph.length - 1] : (segs.slice().sort((a, b) => b.length - a.length)[0] || '');
  // Style codes mixed into slugs ("M0531OZDC", "M900", "Y0996000") carry letters and 2+ digits.
  const codeWord = w => /[a-z]/i.test(w) && (/\d.*\d/.test(w) || (/\d/.test(w) && w.length > 5));
  const words = slug.replace(/\.(html?|aspx|php|jsp)$/i, '').split(/[-_+\s]+/).filter(w => w && !/^\d{3,}$/.test(w) && !codeWord(w));
  const name = words.join(' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bNo(\d)/g, 'No. $1').slice(0, 80) || brandFromHost(host) + ' item';
  const slugWords = words.map(w => w.toLowerCase()).filter(w => w.length >= 3 && !/^\d+$/.test(w));
  const hay = host + ' ' + u.pathname;
  const limited = LIMITED_SLUG_RX.test(u.pathname);
  return { name, slugWords, brand: brandFromHost(host), tags: tagsFor(hay), limited, limitedNote: limited ? 'The link mentions a special edition' : undefined, color: hue(host) };
}

/* ---------- reading the store page ---------- */
async function fetchText(url, { headers, timeout = 12000 } = {}){
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try { const r = await fetch(url, { signal: c.signal, headers }); if (!r.ok) throw new Error('http ' + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}
async function fetchPageHtml(url){
  for (const rd of READERS) {
    const via = rd.url(url).split('/')[2];
    try {
      const t = await fetchText(rd.url(url), rd);
      if (t && t.length > 500 && /<\s*(html|head|meta|title)\b/i.test(t)) { console.info(`[wishlist] read ${url} via ${via} (${t.length} chars)`); return t; }
      console.warn(`[wishlist] ${via} returned no usable HTML for ${url}`);
    } catch (e) { console.warn(`[wishlist] ${via} failed for ${url}:`, e && e.message); }
  }
  return null;
}
// "18,90" -> 18.9 ; "1,299.00" -> 1299 ; "1.299,00" -> 1299
const num = v => {
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
};
const str = v => typeof v === 'string' ? v.trim() : (v && typeof v === 'object' && typeof v.name === 'string') ? v.name.trim() : '';
function imageList(v, base){
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(x => imageList(x, base));
  if (typeof v === 'object') return imageList(v.url || v.contentUrl, base);
  try { return [new URL(String(v), base).href]; } catch { return []; }
}
function parseHtmlMeta(html, baseUrl){
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = n => doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content')?.trim() || '';
  const abs = u => { try { return u ? new URL(u, baseUrl).href : ''; } catch { return ''; } };
  const out = {
    title: meta('og:title') || doc.querySelector('title')?.textContent?.trim() || '',
    description: meta('og:description') || meta('description') || '',
    images: [abs(meta('og:image:secure_url')), abs(meta('og:image')), abs(meta('twitter:image'))],
    site: meta('og:site_name'),
    price: num(meta('product:price:amount') || meta('og:price:amount')),
    currency: (meta('product:price:currency') || meta('og:price:currency') || '').toUpperCase(),
    brand: '', ldName: '', ldImages: [], ldPrice: null, ldCurrency: '', ldDescription: '',
  };
  // schema.org Product in JSON-LD, the most reliable source for name, brand and price.
  const seen = new Set();
  const product = p => {
    if (seen.has(p)) return; seen.add(p);
    if (!out.ldName) out.ldName = str(p.name);
    if (!out.brand) out.brand = str(p.brand);
    out.ldImages.push(...imageList(p.image, baseUrl));
    if (!out.ldDescription) out.ldDescription = str(p.description);
    const offers = [].concat(p.offers || []);
    for (const o of offers) {
      if (!o || typeof o !== 'object') continue;
      const ps = [].concat(o.priceSpecification || [])[0];
      const price = num(o.price ?? o.lowPrice ?? o.highPrice ?? ps?.price);
      if (price != null && out.ldPrice == null) { out.ldPrice = price; out.ldCurrency = String(o.priceCurrency || ps?.priceCurrency || '').toUpperCase(); }
    }
  };
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const types = [].concat(node['@type'] || []).map(String);
    if (types.some(t => /product/i.test(t))) product(node);
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) if (node[k]) walk(node[k]);
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(s.textContent)); } catch {} }
  if (out.ldPrice == null && out.price == null) {
    const el = doc.querySelector('[itemprop="price"]');
    out.price = num(el?.getAttribute('content') || el?.textContent);
    if (out.price != null && !out.currency) out.currency = (doc.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content') || '').toUpperCase();
  }
  if (!out.brand) { const b = doc.querySelector('[itemprop="brand"]'); out.brand = str(b?.getAttribute('content') || b?.textContent || ''); }
  return out;
}
async function fetchMicrolink(url){
  const j = JSON.parse(await fetchText(MICROLINK(url), { timeout: 20000 }));
  if (!j || j.status !== 'success' || !j.data) return null;
  const d = j.data;
  return { title: d.title || '', description: d.description || '', images: [d.image?.url || ''], site: d.publisher || '', brand: '', price: null, currency: '', ldName: '', ldImages: [], ldPrice: null, ldCurrency: '', ldDescription: '' };
}
// "Peptide Lip Treatment | rhode" -> "Peptide Lip Treatment"
function cleanName(title, brand, site, host){
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const junk = [brand, site, host.replace(/^www\./, ''), host.replace(/^www\./, '').split('.')[0], brandFromHost(host)].filter(Boolean).map(s => s.toLowerCase());
  const parts = t.split(/\s[|–—]\s|\s-\s|\s·\s|\s:\s/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter(p => !junk.some(j => p.toLowerCase() === j || p.toLowerCase() === j.replace(/\s/g, '') || (j.length > 3 && p.toLowerCase().includes(j) && p.length < j.length + 12)));
    const base = kept.length ? kept : parts;
    t = base.length > 1 && base[base.length - 1].length <= 24 && /official|shop|buy|online|store/i.test(base[base.length - 1]) ? base.slice(0, -1).join(' - ') : base.join(' - ');
    if (kept.length === 1) t = kept[0];
  }
  if (brand && t.toLowerCase().startsWith(brand.toLowerCase() + ' ') && t.length > brand.length + 4) t = t.slice(brand.length).trim();
  t = t.replace(/\s*[-–—]\s*default title$/i, '').replace(/^[-–—|:\s]+|[-–—|:\s]+$/g, '').slice(0, 90);
  // Stores that lowercase everything ("peptide lip treatment") read better in Title Case.
  if (t && t === t.toLowerCase()) t = t.replace(/\b[a-z]/g, c => c.toUpperCase());
  return t;
}
// Price mentioned in page text, with the currency its symbol implies.
function priceFromText(text){
  const m = String(text || '').match(/(CA\$|A\$|US\$|USD|EUR|GBP|CAD|AUD|JPY|€|£|¥|\$)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\b/);
  if (!m) return null;
  const sym = { 'CA$': 'CAD', 'A$': 'AUD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '$': 'USD' };
  const price = num(m[2]); if (price == null) return null;
  return { price, currency: sym[m[1]] || m[1] };
}

// Fetch the store page and fill the item in. Fetched values win over URL guesses; a photo the
// user attached is kept. Returns true when something useful came back.
async function refine(id){
  const cur0 = state.items.find(x => x.id === id); if (!cur0) return false;
  const u = parseUrl(cur0.url); if (!u) { saveItem({ ...cur0, status: 'ready' }); return false; }
  let m = null;
  try {
    const html = await fetchPageHtml(u.href);
    if (html) { m = parseHtmlMeta(html, u.href); if (!(m.ldName || m.title) || (!m.ldName && BLOCKED_RX.test(m.title))) m = null; }
  } catch { m = null; }
  if (!m) { try { m = await fetchMicrolink(u.href); if (m && (!m.title || BLOCKED_RX.test(m.title))) m = null; } catch { m = null; } }
  const cur = state.items.find(x => x.id === id); if (!cur) return false;
  // Details handed over by the bookmarklet were read in the user's own browser and win over anything fetched.
  const given = cur._given || {};
  const settle = () => { const s = { ...cur, status: 'ready' }; delete s._given; saveItem(s); };
  if (!m) { console.warn(`[wishlist] no reader could read ${u.href}`); settle(); return !!given.name; }
  // Some stores answer readers with a different page (Dior's beauty site sends another product).
  // If none of the link's own words appear in what came back, the page is not this product.
  const sw = guessFromUrl(u).slugWords;
  const hay = `${m.ldName} ${m.title} ${m.ldDescription} ${m.description}`.toLowerCase();
  if (sw.length >= 2 && !sw.some(w => hay.includes(w))) {
    console.warn(`[wishlist] page for ${u.href} does not mention ${sw.join('/')} (got "${m.ldName || m.title}"), keeping the link guess`);
    settle(); return !!given.name;
  }
  console.info('[wishlist] metadata for', u.href, { title: m.title, ldName: m.ldName, brand: m.brand, site: m.site, price: m.price, currency: m.currency, ldPrice: m.ldPrice, ldCurrency: m.ldCurrency, images: [...m.images, ...m.ldImages].filter(Boolean).slice(0, 3) });

  const host = u.hostname.toLowerCase();
  const brand = (m.brand || m.site || cur.brand || brandFromHost(host)).slice(0, 60);
  const name = cleanName(m.ldName || m.title, m.brand || brand, m.site, host) || cur.name;
  const desc = m.ldDescription || m.description || '';
  const text = `${host} ${u.pathname} ${name} ${desc}`;
  const next = { ...cur, status: 'ready', name: name.slice(0, 120), brand };
  if (!cur.imageData) { const img = pickImage([...m.images, ...m.ldImages]); if (img) next.image = img; }
  const okCur = c => /^[A-Z]{3}$/.test(c) ? c : 'USD';
  if (m.ldPrice != null) { next.price = m.ldPrice; next.currency = okCur(m.ldCurrency || m.currency); next.priceGuess = false; }
  else if (m.price != null) { next.price = m.price; next.currency = okCur(m.currency); next.priceGuess = false; }
  else { const p = priceFromText(`${m.title} ${desc}`); if (p) { next.price = p.price; next.currency = p.currency; next.priceGuess = true; } }
  const t = tagsFor(text); if (t[0] !== 'other' || !cur.tags?.length) next.tags = t;
  const lm = text.match(LIMITED_TEXT_RX);
  if (lm) { next.limited = true; next.limitedNote = `The store page says "${lm[0]}"`; }
  else if (LIMITED_SLUG_RX.test(u.pathname)) { next.limited = true; next.limitedNote = cur.limitedNote || 'The link mentions a special edition'; }
  next.color = hue(brand);
  Object.assign(next, given); delete next._given;
  saveItem(next);
  return true;
}

// `given` holds details the bookmarklet read on the store page itself: name, brand, price, currency, image.
async function addFromLink(raw, imageBlob, given = {}){
  const u = parseUrl(raw); if (!u) { toast('That does not look like a link.'); return false; }
  const g = guessFromUrl(u);
  const item = { id: uid(), url: u.href, name: g.name, brand: g.brand, tags: g.tags, limited: g.limited, limitedNote: g.limitedNote, color: g.color, price: null, currency: 'USD', createdAt: Date.now(), status: 'reading', got: false };
  if (imageBlob) Object.assign(item, await storeImage(imageBlob));
  if (given.name) {
    given.name = cleanName(given.name, given.brand || g.brand, '', u.hostname.toLowerCase()) || given.name;
    item.tags = tagsFor(`${u.hostname} ${u.pathname} ${given.name}`);
    if (LIMITED_TEXT_RX.test(given.name)) { item.limited = true; item.limitedNote = 'The product name says so'; }
  }
  if (Object.keys(given).length) { Object.assign(item, given); item._given = given; }
  saveItem(item);
  refine(item.id).then(ok => { if (!ok) toast('Could not read that store page (some stores block readers). Added from the link alone; click it to edit or attach a photo.'); });
  return true;
}

/* ---------- derived ---------- */
function visible(){
  let arr = state.items.slice();
  if (state.filter !== 'all') arr = arr.filter(i => (i.tags || []).includes(state.filter));
  if (state.hideGot) arr = arr.filter(i => !i.got);
  switch (state.sort) {
    case 'price-desc': arr.sort((a, b) => (shown(b) ?? -1) - (shown(a) ?? -1)); break;
    case 'price-asc': arr.sort((a, b) => (shown(a) ?? Infinity) - (shown(b) ?? Infinity)); break;
    case 'name': arr.sort((a, b) => String(a.name).localeCompare(String(b.name))); break;
    case 'brand': arr.sort((a, b) => String(a.brand || hostOf(a.url)).localeCompare(String(b.brand || hostOf(b.url)), undefined, { sensitivity: 'base' }) || String(a.name).localeCompare(String(b.name))); break;
    case 'category': arr.sort((a, b) => String((a.tags || [])[0] || 'other').localeCompare(String((b.tags || [])[0] || 'other')) || String(a.name).localeCompare(String(b.name))); break;
    default: arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return arr;
}
const sumOf = arr => arr.reduce((s, i) => s + (!i.got ? (shown(i) ?? 0) : 0), 0);

/* ---------- render ---------- */
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>';
const leBadge = (cls = '') => `<span class="le ${cls}" title="Limited edition">${STAR}Limited edition</span>`;
function phHTML(i){ return `<div class="ph" style="--h:${Number(i.color) || hue(i.brand)}"><span>${esc((i.brand || i.name || '?').trim().charAt(0).toUpperCase())}</span></div>`; }
function mediaHTML(i){
  const src = imgSrc(i);
  // Placeholder sits underneath; a remote photo that fails falls back to the original, then hides.
  const hint = !src && i.status !== 'reading' ? '<span class="addph">Add a photo</span>' : '';
  return phHTML(i) + (src ? imgTag(src, true) : '') + hint + (i.status === 'reading' ? '<span class="reading">Reading link</span>' : '');
}
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const delBtn = () => `<button type="button" class="ghost del" data-action="del" title="Remove" aria-label="Remove">${TRASH}</button>`;
const tagsHTML = tags => (tags || []).map(t => `<span class="tag" style="--h:${hue(t)}">${esc(t)}</span>`).join('');
function priceHTML(i){
  if (typeof i.price !== 'number') return '<span class="noprice">No price yet</span>';
  const cur = i.currency || 'USD', v = shown(i);
  if (v == null) return `${money(i.price, cur)}${i.priceGuess ? '<small>est.</small>' : ''}`;
  let h = `${money(v)}${i.priceGuess ? '<small>est.</small>' : ''}`;
  if (cur !== state.displayCur) h += `<span class="orig">${money(i.price, cur)}</span>`;
  return h;
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function cardHTML(i){
  return `<article class="card ${i.limited ? 'is-limited' : ''} ${i.got ? 'is-got' : ''}" data-id="${esc(i.id)}">
    <button type="button" class="media" data-action="edit" aria-label="Edit ${esc(i.name)}">${mediaHTML(i)}${i.limited ? leBadge('le-float') : ''}</button>
    <div class="card-body">
      <div class="brand">${esc(i.brand || hostOf(i.url))}</div>
      <h3 class="name">${esc(i.name || 'Untitled')}</h3>
      <div class="card-foot"><div class="tags">${tagsHTML(i.tags)}</div><div class="price">${priceHTML(i)}</div></div>
      <div class="card-actions">
        ${i.url ? `<a class="link" href="${esc(i.url)}" target="_blank" rel="noopener">View ${esc(hostOf(i.url))}</a>` : '<span></span>'}
        <span class="acts"><button type="button" class="ghost" data-action="got" aria-pressed="${i.got ? 'true' : 'false'}">${i.got ? 'Got it ✓' : 'Got it'}</button>${delBtn()}</span>
      </div>
    </div></article>`;
}
function rowHTML(i){
  return `<article class="row ${i.limited ? 'is-limited' : ''} ${i.got ? 'is-got' : ''}" data-id="${esc(i.id)}">
    <button type="button" class="media" data-action="edit" aria-label="Edit ${esc(i.name)}">${mediaHTML(i)}</button>
    <div class="row-main">
      <div class="row-top"><span class="brand">${esc(i.brand || hostOf(i.url))}</span>${i.limited ? leBadge() : ''}</div>
      <h3 class="name">${esc(i.name || 'Untitled')}</h3>
      <div class="tags">${tagsHTML(i.tags)}</div>
    </div>
    <div class="row-side">
      <div class="price">${priceHTML(i)}</div>
      <div class="row-actions">
        ${i.url ? `<a class="link" href="${esc(i.url)}" target="_blank" rel="noopener">View</a>` : ''}
        <button type="button" class="ghost" data-action="got" aria-pressed="${i.got ? 'true' : 'false'}">${i.got ? 'Got it ✓' : 'Got it'}</button>
        <button type="button" class="ghost" data-action="edit">Edit</button>
        ${delBtn()}
      </div>
    </div></article>`;
}
function renderBudget(){
  const b = state.budget, box = $('#budget');
  const wanted = state.items.filter(i => !i.got);
  const total = sumOf(wanted);
  $('#budgetCur').textContent = state.displayCur;
  if (!b) {
    box.classList.remove('is-over'); $('#budgetEdit').textContent = 'Set a budget';
    $('#budgetBar').hidden = true; $('#budgetNote').hidden = true; return;
  }
  const limit = convert(b.amount, b.currency, state.displayCur);
  $('#budgetEdit').textContent = 'Edit';
  if (limit == null) { $('#budgetBar').hidden = true; $('#budgetNote').hidden = false; $('#budgetNote').textContent = `Budget ${money(b.amount, b.currency)} (no rate to convert it).`; return; }
  const pct = Math.min(100, limit > 0 ? total / limit * 100 : 100);
  const over = total > limit;
  box.classList.toggle('is-over', over);
  $('#budgetBar').hidden = false; $('#budgetFill').style.width = pct.toFixed(1) + '%';
  $('#budgetNote').hidden = false;
  $('#budgetNote').innerHTML = over
    ? `Whole list is <b>${money(total - limit)} over</b> your ${money(limit)} budget.`
    : `Whole list: <b>${money(total)}</b> of ${money(limit)} · <b>${money(limit - total)}</b> left.`;
}
function render(){
  const arr = visible();
  const total = sumOf(arr);
  $('#hdrTotal').textContent = money(total);
  const counted = arr.filter(i => !i.got).length;
  $('#hdrLbl').textContent = `${counted} item${counted === 1 ? '' : 's'}${state.filter !== 'all' ? ' · ' + state.filter : ''}`;
  $('#tCount').textContent = String(arr.length);
  $('#tLimited').textContent = String(arr.filter(i => i.limited).length);
  $('#tNoPrice').textContent = String(arr.filter(i => typeof i.price !== 'number').length);
  $('#tTotal').textContent = money(total);
  const foreign = state.items.some(i => typeof i.price === 'number' && (i.currency || 'USD') !== state.displayCur);
  $('#ledgerNote').textContent = (foreign ? `Converted with European Central Bank rates from ${fx.date}. ` : '') + 'Prices marked est. were guessed from the page text rather than read from a price field. Items marked got-it are not counted.';
  renderBudget();
  const counts = {}; for (const i of state.items) for (const t of (i.tags || [])) counts[t] = (counts[t] || 0) + 1;
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  if (state.filter !== 'all' && !counts[state.filter]) state.filter = 'all';
  $('#chips').innerHTML = `<button type="button" class="chip" data-tag="all" aria-pressed="${state.filter === 'all'}">All <span class="n">${state.items.length}</span></button>` +
    tags.map(t => `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="${state.filter === t}">${esc(t)} <span class="n">${counts[t]}</span></button>`).join('');
  $('#viewGallery').setAttribute('aria-pressed', String(state.view === 'gallery'));
  $('#viewList').setAttribute('aria-pressed', String(state.view === 'list'));
  $('#sort').value = state.sort; $('#groupBy').checked = state.group; $('#hideGot').checked = state.hideGot;
  $('#exampleNotice').hidden = !state.items.some(i => i.example);
  const main = $('#items');
  if (!arr.length) {
    main.innerHTML = `<div class="empty"><div class="empty-cards" aria-hidden="true"><span></span><span></span><span></span></div>
      <h2>${state.items.length ? 'Nothing here yet' : 'Your list is empty'}</h2>
      <p>${state.items.length ? 'No items match this filter.' : 'Paste a product link above. The page reads the details from the store and limited editions get a gold mark.'}</p></div>`;
    return;
  }
  const item = state.view === 'gallery' ? cardHTML : rowHTML;
  const wrapCls = state.view === 'gallery' ? 'gallery' : 'list';
  if (state.group && state.filter === 'all') {
    const groups = {}; for (const i of arr) { const t = (i.tags && i.tags[0]) || 'other'; (groups[t] ||= []).push(i); }
    const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    main.innerHTML = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b)).map(t => {
      const open = !state.collapsed.includes(t);
      return `<h2 class="group-h ${open ? '' : 'is-closed'}"><button type="button" class="group-toggle" data-group="${esc(t)}" aria-expanded="${open}">${CHEV}<span>${esc(t)}</span></button><span class="n">${groups[t].length}</span><span class="sum">${money(sumOf(groups[t]))}</span></h2>` +
        (open ? `<div class="${wrapCls}">${groups[t].map(item).join('')}</div>` : '');
    }).join('');
  } else {
    main.innerHTML = `<div class="${wrapCls}">${arr.map(item).join('')}</div>`;
  }
}

/* ---------- edit sheet ---------- */
function openSheet(id){
  const i = state.items.find(x => x.id === id); if (!i) return;
  state.editing = { ...i, newImage: null, newImagePreview: null };
  $('#fName').value = i.name || ''; $('#fBrand').value = i.brand || ''; $('#fPrice').value = typeof i.price === 'number' ? i.price : '';
  $('#fCurrency').value = currencyList().includes(i.currency) ? i.currency : 'USD';
  $('#fTags').value = (i.tags || []).join(', '); $('#fLimited').checked = !!i.limited; $('#fLimitedNote').value = i.limitedNote || '';
  $('#fUrl').value = i.url || ''; $('#fImage').value = i.image || ''; $('#fNote').value = i.note || '';
  $('#fGot').textContent = i.got ? 'Not got yet' : 'Got it'; $('#fDelete').textContent = 'Remove';
  renderSheetMedia(); renderSugg();
  $('#scrim').hidden = false; $('#sheet').hidden = false; $('#fName').focus();
}
function closeSheet(){
  if (state.editing?.newImagePreview) URL.revokeObjectURL(state.editing.newImagePreview);
  state.editing = null; $('#scrim').hidden = true; $('#sheet').hidden = true;
}
function renderSheetMedia(){
  const e = state.editing; const src = e.newImagePreview || e.imageData || $('#fImage').value.trim() || null;
  $('#sheetMediaInner').innerHTML = phHTML(e) + (src ? imgTag(src, false) : '');
}
function currentTags(){ return $('#fTags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
function renderSugg(){
  const cur = currentTags();
  const all = Array.from(new Set([...TAG_SET, ...state.items.flatMap(i => i.tags || [])]));
  $('#sugg').innerHTML = all.map(t => `<button type="button" data-tag="${esc(t)}" aria-pressed="${cur.includes(t)}">${esc(t)}</button>`).join('');
}
function setSheetImage(file){
  if (!file || !file.type.startsWith('image/') || !state.editing) return;
  if (state.editing.newImagePreview) URL.revokeObjectURL(state.editing.newImagePreview);
  state.editing.newImage = file; state.editing.newImagePreview = URL.createObjectURL(file); renderSheetMedia();
}
async function saveSheet(){
  const e = state.editing; if (!e) return;
  const priceRaw = $('#fPrice').value.trim();
  const price = priceRaw === '' ? null : Math.max(0, Math.round(parseFloat(priceRaw) * 100) / 100);
  const u = parseUrl($('#fUrl').value);
  const imageUrl = $('#fImage').value.trim();
  const next = { ...e, name: $('#fName').value.trim() || 'Untitled', brand: $('#fBrand').value.trim(), price: price != null && isFinite(price) ? price : null, priceGuess: false,
    currency: $('#fCurrency').value || 'USD',
    tags: Array.from(new Set(currentTags())).slice(0, 5), limited: $('#fLimited').checked, limitedNote: $('#fLimitedNote').value.trim() || undefined,
    url: u ? u.href : ($('#fUrl').value.trim() ? e.url : ''), note: $('#fNote').value.trim() || undefined, status: 'ready' };
  if (!next.tags.length) next.tags = ['other'];
  if (imageUrl !== (e.image || '')) { next.image = /^https?:\/\//i.test(imageUrl) ? imageUrl.replace(/^http:\/\//i, 'https://') : undefined; if (next.image) next.imageData = undefined; }
  delete next.newImage; delete next.newImagePreview;
  $('#fSave').disabled = true; $('#fSave').textContent = 'Saving';
  try { if (e.newImage) Object.assign(next, await storeImage(e.newImage)); } finally { $('#fSave').disabled = false; $('#fSave').textContent = 'Save'; }
  closeSheet(); saveItem(next);
}

/* ---------- export / import ---------- */
function exportJSON(){
  const data = { version: 1, exportedAt: new Date().toISOString(), items: state.items.map(i => { const { status, ...rest } = i; return rest; }) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `wishlist-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Exported ${data.items.length} item${data.items.length === 1 ? '' : 's'}.`);
}
function parseImport(text){
  const j = JSON.parse(text);
  const arr = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null;
  if (!arr) throw new Error('shape');
  return arr.map(sanitizeItem).filter(Boolean);
}
async function importJSON(file){
  try {
    const items = parseImport(await file.text());
    const byId = new Map(state.items.map(i => [i.id, i]));
    let added = 0, updated = 0;
    for (const it of items) { if (byId.has(it.id)) updated++; else added++; byId.set(it.id, it); }
    state.items = Array.from(byId.values()); persist(); render();
    toast(`Imported ${added} new, ${updated} updated.`);
  } catch { toast('That file is not a wishlist export.'); }
}

/* ---------- events ---------- */
$('#themeBtn').onclick = () => applyTheme(state.theme === 'dark' ? 'light' : 'dark');
$('#items').addEventListener('click', ev => {
  const g = ev.target.closest('[data-group]');
  if (g) {
    const t = g.dataset.group;
    state.collapsed = state.collapsed.includes(t) ? state.collapsed.filter(x => x !== t) : [...state.collapsed, t];
    store.set('collapsed', state.collapsed); render(); return;
  }
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const id = b.closest('[data-id]')?.dataset.id; const i = state.items.find(x => x.id === id); if (!i) return;
  if (b.dataset.action === 'edit') openSheet(id);
  if (b.dataset.action === 'got') saveItem({ ...i, got: !i.got });
  if (b.dataset.action === 'del') {
    // Two taps to remove: the first arms the button for three seconds.
    if (b.dataset.armed) { deleteItem(id); toast(`Removed ${i.name}.`); return; }
    b.dataset.armed = '1'; b.textContent = 'Sure?';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.innerHTML = TRASH; } }, 3000);
  }
});
$('#chips').addEventListener('click', ev => { const c = ev.target.closest('.chip'); if (!c) return; state.filter = c.dataset.tag; render(); });
$('#viewGallery').onclick = () => { state.view = 'gallery'; store.set('view', 'gallery'); render(); };
$('#viewList').onclick = () => { state.view = 'list'; store.set('view', 'list'); render(); };
$('#sort').onchange = ev => { state.sort = ev.target.value; store.set('sort', state.sort); render(); };
$('#groupBy').onchange = ev => { state.group = ev.target.checked; store.set('group', state.group); render(); };
$('#hideGot').onchange = ev => { state.hideGot = ev.target.checked; store.set('hideGot', state.hideGot); render(); };
$('#clearExamples').onclick = () => { state.items = state.items.filter(x => !x.example); persist(); render(); };
$('#displayCur').onchange = ev => { state.displayCur = ev.target.value; store.set('displayCur', state.displayCur); render(); };

// budget
$('#budgetEdit').onclick = () => {
  const f = $('#budgetForm'); f.hidden = !f.hidden;
  if (!f.hidden) { $('#budgetInput').value = state.budget ? (convert(state.budget.amount, state.budget.currency, state.displayCur) ?? state.budget.amount).toFixed(0) : ''; $('#budgetClear').hidden = !state.budget; $('#budgetInput').focus(); }
};
$('#budgetForm').onsubmit = ev => {
  ev.preventDefault();
  const v = parseFloat($('#budgetInput').value);
  if (!isFinite(v) || v <= 0) { toast('Enter a budget amount.'); return; }
  state.budget = { amount: Math.round(v * 100) / 100, currency: state.displayCur }; store.set('budget', state.budget);
  $('#budgetForm').hidden = true; render();
};
$('#budgetClear').onclick = () => { state.budget = null; store.set('budget', null); $('#budgetForm').hidden = true; render(); };

// add bar
function setDraft(file){
  if (!file || !file.type.startsWith('image/')) return;
  state.draftImage = file; $('#addPreviewImg').src = URL.createObjectURL(file); $('#addPreview').hidden = false; $('#addHint').hidden = true; $('#addImgBtn').classList.add('has-img'); $('#addUrl').focus();
}
function clearDraft(){ state.draftImage = null; $('#addPreview').hidden = true; $('#addHint').hidden = false; $('#addImgBtn').classList.remove('has-img'); }
$('#addImgBtn').onclick = () => $('#addImgFile').click();
$('#addImgFile').onchange = ev => { setDraft(ev.target.files[0]); ev.target.value = ''; };
$('#addPreviewClear').onclick = clearDraft;
$('#addForm').onsubmit = async ev => {
  ev.preventDefault();
  const v = $('#addUrl').value.trim(); if (!v) { $('#addUrl').focus(); return; }
  $('#addBtn').disabled = true;
  const ok = await addFromLink(v, state.draftImage);
  $('#addBtn').disabled = false;
  if (ok) { $('#addUrl').value = ''; clearDraft(); }
};
{
  const el = $('#addField');
  el.addEventListener('dragover', ev => { ev.preventDefault(); el.classList.add('is-drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-drag'));
  el.addEventListener('drop', ev => { ev.preventDefault(); el.classList.remove('is-drag'); const f = ev.dataTransfer.files?.[0]; if (f) setDraft(f); const t = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text'); if (t && parseUrl(t)) $('#addUrl').value = t.trim(); });
}
// paste anywhere: an image becomes the draft photo (or the sheet photo); a link fills the add bar
document.addEventListener('paste', ev => {
  const files = Array.from(ev.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
  if (files.length) { ev.preventDefault(); if (state.editing) setSheetImage(files[0]); else setDraft(files[0]); return; }
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (inInput || state.editing) return;
  const text = ev.clipboardData?.getData('text') || '';
  if (parseUrl(text)) { ev.preventDefault(); $('#addUrl').value = text.trim(); $('#addUrl').focus(); }
});

// sheet
$('#scrim').onclick = closeSheet; $('#sheetClose').onclick = closeSheet;
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && state.editing) closeSheet(); });
$('#fSave').onclick = saveSheet;
$('#fGot').onclick = () => { const e = state.editing; if (!e) return; const cur = state.items.find(x => x.id === e.id); closeSheet(); if (cur) saveItem({ ...cur, got: !cur.got }); };
$('#fDelete').onclick = () => { const b = $('#fDelete'); if (b.textContent !== 'Really remove?') { b.textContent = 'Really remove?'; return; } const id = state.editing.id; closeSheet(); deleteItem(id); };
$('#fRefetch').onclick = async () => {
  const e = state.editing; if (!e) return;
  const u = parseUrl($('#fUrl').value); if (!u) { toast('Add a link first.'); return; }
  const cur = state.items.find(x => x.id === e.id); if (!cur) return;
  closeSheet();
  saveItem({ ...cur, url: u.href, status: 'reading' });
  const ok = await refine(cur.id);
  toast(ok ? 'Details updated from the store page.' : 'Could not read that store page.');
};
$('#sugg').addEventListener('click', ev => { const b = ev.target.closest('[data-tag]'); if (!b) return; const t = b.dataset.tag; let cur = currentTags(); cur = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]; $('#fTags').value = cur.join(', '); renderSugg(); });
$('#fTags').addEventListener('input', renderSugg);
$('#fImage').addEventListener('change', () => { if (state.editing) renderSheetMedia(); });
$('#fLimited').onchange = ev => { if (ev.target.checked && !$('#fLimitedNote').value) $('#fLimitedNote').focus(); };
const sm = $('#sheetMedia');
sm.onclick = () => $('#sheetFile').click();
sm.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('#sheetFile').click(); } };
$('#sheetFile').onchange = ev => { setSheetImage(ev.target.files[0]); ev.target.value = ''; };
sm.addEventListener('dragover', ev => { ev.preventDefault(); sm.classList.add('is-drag'); });
sm.addEventListener('dragleave', () => sm.classList.remove('is-drag'));
sm.addEventListener('drop', ev => { ev.preventDefault(); sm.classList.remove('is-drag'); setSheetImage(ev.dataTransfer.files?.[0]); });

// data bar
$('#exportBtn').onclick = exportJSON;
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = ev => { const f = ev.target.files[0]; if (f) importJSON(f); ev.target.value = ''; };
$('#resetBtn').onclick = () => {
  const b = $('#resetBtn');
  if (b.textContent !== 'Really clear everything?') { b.textContent = 'Really clear everything?'; setTimeout(() => { b.textContent = 'Start over'; }, 4000); return; }
  state.items = []; persist(); render(); b.textContent = 'Start over'; toast('List cleared.');
};

/* ---------- toast ---------- */
let toastT;
function toast(msg){ let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4800); }

/* ---------- boot ---------- */
{ const q = new URLSearchParams(location.search).get('theme'); if (q === 'dark' || q === 'light') state.theme = q; }
applyTheme(state.theme);
fillCurrencySelects();
(async () => {
  if (store.has('items')) {
    state.items = (store.get('items', []) || []).map(sanitizeItem).filter(Boolean);
    render();
  } else {
    // First visit in this browser: seed from the wishlist.json published with the site, if any.
    render();
    try {
      const r = await fetch(SEED_FILE, { cache: 'no-store' });
      if (r.ok) { state.items = parseImport(await r.text()); }
    } catch {}
    persist(); render();
  }
  loadRates();
  // ?add=<link> adds that link on load. The bookmarklet also passes name, brand, price, cur, image, est.
  const qs = new URLSearchParams(location.search);
  const add = qs.get('add');
  if (add && parseUrl(add)) {
    const given = {};
    const nm = (qs.get('name') || '').trim(); if (nm) given.name = nm.slice(0, 120);
    const br = (qs.get('brand') || '').trim(); if (br) given.brand = br.slice(0, 60);
    const pr = num(qs.get('price')); if (pr != null) { given.price = pr; given.priceGuess = qs.get('est') === '1'; const c = (qs.get('cur') || 'USD').toUpperCase(); given.currency = /^[A-Z]{3}$/.test(c) ? c : 'USD'; }
    const im = pickImage([qs.get('image') || '']); if (im) given.image = im;
    history.replaceState(null, '', location.pathname);
    addFromLink(add, null, given);
  }
  // Tell the bookmarklet (our opener) we are ready to receive the photo it captured on the store page.
  if (window.opener) { try { window.opener.postMessage('wishlist-ready', '*'); } catch {} }
})();
// Photo handed over by the bookmarklet: a small JPEG data URL captured on the store page, where the
// store's own image is same-origin and readable. It is attached to the item with that link.
window.addEventListener('message', ev => {
  const d = ev.data;
  if (!d || d.type !== 'wishlist-photo' || typeof d.imageData !== 'string' || !d.imageData.startsWith('data:image/') || d.imageData.length > 2.5e6) return;
  const u = parseUrl(d.url); if (!u) return;
  const it = state.items.find(x => x.url === u.href); if (!it || it.imageData) return;
  saveItem({ ...it, imageData: d.imageData, image: undefined });
  toast('Photo added from the store page.');
});

/* ---------- bookmarklet ---------- */
// Runs on a store page in the user's own browser (where nothing is blocked), reads the product
// details from that page, and opens the wishlist with them. The wishlist URL is filled in below.
const BOOKMARKLET = `(function(){var d=document,q=function(s){var e=d.querySelector(s);return e?(e.getAttribute('content')||e.textContent||'').trim():''};var n='',b='',p='',cu='',im='',est='';var sc=d.querySelectorAll('script[type="application/ld+json"]');for(var i=0;i<sc.length;i++){try{var j=JSON.parse(sc[i].textContent);var a=[].concat(j['@graph']||j);for(var k=0;k<a.length;k++){var o=a[k];if(o&&/Product/.test(String(o['@type']))){if(!n&&typeof o.name=='string')n=o.name;if(!b&&o.brand)b=o.brand.name||(typeof o.brand=='string'?o.brand:'');var f=[].concat(o.offers||[])[0];if(f&&!p&&(f.price||f.lowPrice)){p=String(f.price||f.lowPrice);cu=f.priceCurrency||''}var g=[].concat(o.image||[])[0];if(!im&&g)im=g.url||(typeof g=='string'?g:'')}}}catch(e){}}n=n||q('meta[property="og:title"]')||d.title;im=q('meta[property="og:image"]')||im;if(!p){p=q('meta[property="product:price:amount"]')||q('[itemprop="price"]');cu=cu||q('meta[property="product:price:currency"]')}if(!p){var t=(d.body.innerText||'').slice(0,20000),m=t.match(/(\\u20ac|\\u00a3|\\$)\\s?(\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d\\d)?)/);if(m){p=m[2];cu={'\\u20ac':'EUR','\\u00a3':'GBP','$':'USD'}[m[1]];est='1'}}var u='__WISHLIST__?add='+encodeURIComponent(location.href)+'&name='+encodeURIComponent(n)+'&brand='+encodeURIComponent(b)+'&price='+encodeURIComponent(p||'')+'&cur='+encodeURIComponent(cu||'')+'&image='+encodeURIComponent(im||'')+'&est='+est;var w=window.open(u,'_blank');if(im&&w){try{var g=new Image();g.crossOrigin='anonymous';g.onload=function(){try{var s=Math.min(1,800/Math.max(g.naturalWidth,g.naturalHeight)),c=d.createElement('canvas');c.width=Math.round(g.naturalWidth*s);c.height=Math.round(g.naturalHeight*s);var x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.drawImage(g,0,0,c.width,c.height);var data=c.toDataURL('image/jpeg',0.85);var send=function(){try{w.postMessage({type:'wishlist-photo',url:location.href,imageData:data},'*')}catch(e){}};window.addEventListener('message',function(e){if(e.data==='wishlist-ready')send()});setTimeout(send,3000);setTimeout(send,7000)}catch(e){}};g.src=im}catch(e){}}})();`;
{
  const a = $('#bookmarklet');
  if (a) {
    a.href = 'javascript:' + BOOKMARKLET.replace('__WISHLIST__', location.origin + location.pathname);
    a.onclick = ev => { ev.preventDefault(); toast('Drag this button to your bookmarks bar, then click it while viewing a product on any store.'); };
  }
}
// Debug hooks for the browser console, e.g. wlDebug.read('https://…') to see what the readers return.
window.wlDebug = { state, read: async u => { const h = await fetchPageHtml(u); return h ? parseHtmlMeta(h, u) : null; }, microlink: fetchMicrolink, refine, rates: () => fx };
})();
