// Bundled email-HTML samples for the /transform demo. Self-authored in the
// style of real marketing/transactional emails (CC0 — no copyrighted
// templates). Each is a BODY FRAGMENT (no <html>/<head> wrapper) — the shape
// an email transformer actually works on — and each deliberately contains the
// hostile bits the sanitize stage exists for: <script>, inline event
// handlers, javascript: URLs.

export interface EmailSample {
  id: string;
  name: string;
  description: string;
  html: string;
}

const LAUNCH_HTML = `<div class="card" style="max-width:600px;margin:0 auto">
  <script>document.cookie = "tracked=1"; fetch("https://evil.example/beacon");</script>
  <img src="https://img.example.com/logo.png" alt="Acme" width="120" height="40">
  <h1 class="heading">Meet the new Acme Dashboard</h1>
  <p class="body-text">
    We rebuilt reporting from the ground up. Live charts, custom exports, and
    an API that finally keeps up with you. It ships to every workspace today.
  </p>
  <p class="body-text">
    Your existing boards migrate automatically &mdash; nothing to configure,
    nothing to lose.
  </p>
  <p style="text-align:center">
    <a class="btn" href="https://app.example.com/dashboard?plan=pro" onclick="window.__track('cta')">Open your dashboard</a>
  </p>
  <hr class="divider">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" class="muted">
        Read the <a href="https://example.com/blog/dashboard-launch#highlights">launch post</a>
        or skim the <a href="https://docs.example.com/changelog?version=42">changelog</a>.
      </td>
    </tr>
  </table>
  <p class="body-text">
    Questions? Just reply, or reach us at
    <a href="mailto:support@example.com">support@example.com</a>.
    Feeling brave? <a href="javascript:alert('gotcha')">Click here</a>.
  </p>
  <div onmouseover="stealFocus()" class="footer">
    Acme Inc &middot; 100 Market St &middot; San Francisco, CA<br>
    <a href="https://example.com/unsubscribe?u=123&utm_source=old-campaign">Unsubscribe</a> &middot;
    <a href="https://example.com/preferences?u=123">Email preferences</a>
  </div>
</div>`;

const RECEIPT_HTML = `<div class="card" style="max-width:600px;margin:0 auto">
  <h1 class="heading">Thanks for your order, Dana</h1>
  <p class="body-text">Order <strong>#48151-62342</strong> is confirmed and on its way.</p>
  <style>.hidden-tracker { background: url("https://evil.example/css-beacon"); }</style>
  <table width="100%" cellpadding="8" cellspacing="0" border="0">
    <thead>
      <tr>
        <th align="left" class="muted">Item</th>
        <th align="right" class="muted">Qty</th>
        <th align="right" class="muted">Price</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td align="left">Field Notes &mdash; 3 pack</td>
        <td align="right">2</td>
        <td align="right">$25.90</td>
      </tr>
      <tr>
        <td align="left">Brass pen, matte</td>
        <td align="right">1</td>
        <td align="right">$48.00</td>
      </tr>
      <tr>
        <td align="left"><em>Ground shipping</em></td>
        <td align="right"></td>
        <td align="right">$6.50</td>
      </tr>
      <tr>
        <td align="left"><strong>Total</strong></td>
        <td align="right"></td>
        <td align="right"><strong>$80.40</strong></td>
      </tr>
    </tbody>
  </table>
  <p style="text-align:center">
    <a class="btn" href="https://shop.example.com/orders/48151-62342/track">Track your package</a>
  </p>
  <iframe src="https://evil.example/invisible" width="1" height="1"></iframe>
  <hr class="divider">
  <p class="body-text muted">
    Need a change? You can <a href="https://shop.example.com/orders/48151-62342/edit">edit this order</a>
    for the next 30 minutes, or <a href="mailto:orders@shop.example.com">email us</a>.
  </p>
  <img src="https://evil.example/pixel.gif" onerror="this.src='https://evil.example/retry'" width="1" height="1" alt="">
  <div class="footer">
    Field Supply Co &middot; 9 Canal St &middot; Portland, OR<br>
    <a href="https://shop.example.com/unsubscribe?u=dana">Unsubscribe</a>
  </div>
</div>`;

interface PromoProduct {
  name: string;
  pitch: string;
  price: string;
  slug: string;
}

const PROMO_PRODUCTS: readonly PromoProduct[] = [
  { name: "Trailhead 28L pack", pitch: "Carry-on sized, bombproof zips", price: "$129", slug: "trailhead-28" },
  { name: "Ridge merino tee", pitch: "Three days, zero smell", price: "$58", slug: "ridge-tee" },
  { name: "Cascade rain shell", pitch: "2.5-layer, packs to a fist", price: "$149", slug: "cascade-shell" },
  { name: "Ember camp mug", pitch: "Double wall, actually 12oz", price: "$24", slug: "ember-mug" },
  { name: "Summit sock, 2-pack", pitch: "Wool blend, seamless toe", price: "$32", slug: "summit-sock" },
  { name: "Basin water filter", pitch: "2L/min, cleans itself", price: "$45", slug: "basin-filter" },
  { name: "Granite headlamp", pitch: "400 lumens, USB-C", price: "$39", slug: "granite-lamp" },
  { name: "Juniper camp chair", pitch: "1.1lb, holds 300", price: "$89", slug: "juniper-chair" },
  { name: "Alpine down quilt", pitch: "20°F, 19oz", price: "$219", slug: "alpine-quilt" },
  { name: "Fern first-aid kit", pitch: "Trail-sized, restockable", price: "$28", slug: "fern-kit" },
  { name: "Cinder stove", pitch: "Boils in 3:30", price: "$54", slug: "cinder-stove" },
  { name: "Lookout dry bag 10L", pitch: "Actually submersible", price: "$26", slug: "lookout-dry" },
];

function promoBlock(product: PromoProduct): string {
  return `  <table width="100%" cellpadding="0" cellspacing="0" class="card" style="margin-bottom:16px">
    <tr>
      <td width="96" valign="top">
        <img src="https://img.example.com/products/${product.slug}.jpg" alt="${product.name}" width="96" height="96">
      </td>
      <td valign="top" style="padding-left:16px">
        <p class="body-text" style="margin-bottom:4px"><strong>${product.name}</strong></p>
        <p class="muted">${product.pitch}</p>
        <p class="body-text"><strong>${product.price}</strong> &mdash;
          <a href="https://store.example.com/p/${product.slug}?ref=summer">Shop now</a></p>
      </td>
    </tr>
  </table>`;
}

// The largest sample (used by the benchmark suite): a long promo blast built
// from repeated product blocks, the way real campaign HTML repeats modules.
const PROMO_HTML = `<div style="max-width:600px;margin:0 auto">
  <script src="https://evil.example/campaign.js"></script>
  <h1 class="heading">Summer sale: 25% off everything on the trail</h1>
  <p class="body-text">
    Four days only. Every pack, shell, and stove in the store &mdash; 25% off
    with code <strong>SUMMER25</strong> at checkout. No exclusions, no fine print.
  </p>
  <p style="text-align:center">
    <a class="btn" href="https://store.example.com/sale?code=SUMMER25" onclick="beacon('hero')">Shop the sale</a>
  </p>
  <hr class="divider">
${PROMO_PRODUCTS.map(promoBlock).join("\n")}
  <hr class="divider">
  <p class="body-text" style="text-align:center">
    <a class="btn" href="https://store.example.com/sale?code=SUMMER25&src=footer#top">See all 214 items</a>
  </p>
  <p class="muted" style="text-align:center">
    Sale ends Sunday at midnight PT. Questions?
    <a href="mailto:hello@store.example.com">hello@store.example.com</a>
  </p>
  <div class="footer" onmouseover="trackHover()">
    Timberline Outfitters &middot; 41 Pine Ave &middot; Bend, OR<br>
    <a href="https://store.example.com/unsubscribe?u=8827">Unsubscribe</a> &middot;
    <a href="https://store.example.com/view-in-browser?c=summer25">View in browser</a>
  </div>
</div>`;

export const SAMPLES: readonly EmailSample[] = [
  {
    id: "launch",
    name: "Product launch newsletter",
    description: "Announcement email: hero copy, CTA button, tracked links, a smuggled script.",
    html: LAUNCH_HTML,
  },
  {
    id: "receipt",
    name: "Order receipt",
    description: "Transactional email: line-item table, tracking CTA, a hidden iframe and tracking pixel.",
    html: RECEIPT_HTML,
  },
  {
    id: "promo",
    name: "Promo blast (largest)",
    description: "Campaign email: 12 repeated product modules — the sample the benchmark uses.",
    html: PROMO_HTML,
  },
];

export function getSample(id: string): EmailSample | undefined {
  return SAMPLES.find((sample) => sample.id === id);
}

export const LARGEST_SAMPLE: EmailSample = SAMPLES[2];
