const PRODUCTS = {
  "clasiic-core": {
    name: "CORE",
    prices: { black: "price_1U9HmBEh9DXESfsFsAvSNZIa", white: "price_1U9HicEh9DXESfsFYtFSwGqU" }
  },
  "clasiic-core-polo": {
    name: "CORE POLO",
    prices: { black: "price_1U9Hq2Eh9DXESfsF7gQs3l7P", white: "price_1U9Hp4Eh9DXESfsFaZLbAuSk" }
  },
  "clasiic-repeat": {
    name: "REPEAT",
    prices: { black: "price_1U9HsIEh9DXESfsFvmx4GmUj", white: "price_1U9Hr6Eh9DXESfsFmghKrqlO" }
  },
  "clasiic-grid": {
    name: "GRID",
    prices: { black: "price_1U9HtgEh9DXESfsFBTQOsvRq", white: "price_1U9HtAEh9DXESfsFFoEQqkPU" }
  },
  "ediit-sketch": {
    name: "SKETCH",
    prices: { black: "price_1U9HvFEh9DXESfsFddj2y6o7", white: "price_1U9HuTEh9DXESfsFR5VsVBQc" }
  },
  "ediit-build": {
    name: "BUILD",
    prices: { black: "price_1U9HxHEh9DXESfsFIN48pNjN", white: "price_1U9HweEh9DXESfsFjsCOCXum" }
  }
};

const GITHUB_PAGES_ORIGIN = "https://a2jrofficial.github.io";

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (origin !== GITHUB_PAGES_ORIGIN) return {};
  return {
    "access-control-allow-origin": GITHUB_PAGES_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request))) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function colourForVariation(variation) {
  const value = variation.toLowerCase();
  if (value.includes("black")) return "black";
  if (value.includes("white")) return "white";
  return null;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function checkoutForm(items, origin) {
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${origin}/order-confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancelled`,
    billing_address_collection: "required",
    "phone_number_collection[enabled]": "true",
    "shipping_address_collection[allowed_countries][0]": "SG",
    "payment_method_types[0]": "card"
  });

  items.forEach((item, index) => {
    const product = PRODUCTS[item.productId];
    form.set(`line_items[${index}][price]`, product.prices[item.colour]);
    form.set(`line_items[${index}][quantity]`, "1");
    form.set(`metadata[item_${index + 1}]`, `${product.name} / ${item.colour.toUpperCase()} / SIZE ${item.size}`);
  });
  return form;
}

async function createCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Checkout is not configured yet." }, 503);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid CART." }, 400); }
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length || items.length > 20) return json({ error: "Your CART needs between 1 and 20 pieces." }, 400);

  const validItems = items.map((item) => ({
    productId: typeof item?.productId === "string" ? item.productId : "",
    variation: typeof item?.variation === "string" ? item.variation.slice(0, 48) : "",
    size: typeof item?.size === "string" ? item.size.slice(0, 16) : "",
    colour: typeof item?.variation === "string" ? colourForVariation(item.variation) : null
  }));
  if (validItems.some((item) => !PRODUCTS[item.productId] || !item.variation || !item.size || !item.colour)) {
    return json({ error: "One or more CART items are invalid. Please add them again." }, 400);
  }

  const origin = new URL(request.url).origin;
  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: checkoutForm(validItems, origin)
  });
  const session = await stripeResponse.json();
  if (!stripeResponse.ok) return json({ error: session.error?.message || "Stripe could not start checkout." }, 502);
  return json({ url: session.url });
}

async function verifyStripeSignature(request, env) {
  const signature = request.headers.get("Stripe-Signature") || "";
  const timestamp = signature.match(/(?:^|,)t=(\d+)/)?.[1];
  const received = signature.match(/(?:^|,)v1=([a-f0-9]+)/i)?.[1];
  if (!timestamp || !received || !env.STRIPE_WEBHOOK_SECRET) return null;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return null;
  const raw = await request.text();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)));
  const expected = [...signatureBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== received.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return difference === 0 ? JSON.parse(raw) : null;
}

async function storeOrder(session, env) {
  let lineItems = [];
  const lineItemsResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items?limit=100`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  if (lineItemsResponse.ok) lineItems = (await lineItemsResponse.json()).data || [];
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS orders (
    stripe_session_id TEXT PRIMARY KEY,
    payment_status TEXT NOT NULL,
    customer_email TEXT,
    customer_name TEXT,
    phone TEXT,
    shipping_address TEXT,
    amount_total INTEGER,
    currency TEXT,
    items TEXT,
    created_at TEXT NOT NULL
  )`);
  await env.DB.prepare(`INSERT OR IGNORE INTO orders (
    stripe_session_id, payment_status, customer_email, customer_name, phone, shipping_address, amount_total, currency, items, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      session.id,
      session.payment_status || "paid",
      session.customer_details?.email || null,
      session.customer_details?.name || null,
      session.customer_details?.phone || null,
      JSON.stringify(session.collected_information?.shipping_details || session.shipping_details || session.customer_details?.address || null),
      session.amount_total || null,
      session.currency || "sgd",
      JSON.stringify({ selections: session.metadata || {}, lineItems }),
      new Date().toISOString()
    ).run();
}

async function handleWebhook(request, env) {
  const event = await verifyStripeSignature(request, env);
  if (!event) return new Response("Invalid Stripe signature", { status: 400 });
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
    const session = event.data.object;
    if (session.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded") {
      await storeOrder(session, env);
    }
  }
  return new Response("ok");
}

function confirmationPage() {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A2JR — Order confirmed</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#f8f8f5;font-family:Arial,sans-serif}.card{width:min(440px,calc(100% - 48px));border:1px solid #444;padding:40px;text-align:center}.eyebrow{font:10px monospace;letter-spacing:.2em;opacity:.6}h1{font-size:48px;letter-spacing:-.07em;margin:18px 0}p{font:13px/1.6 monospace;color:#bbb}a{display:inline-block;margin-top:18px;padding:13px 16px;border:1px solid currentColor;color:inherit;text-decoration:none;font:10px monospace;letter-spacing:.14em}</style><main class="card"><div class="eyebrow">A2JR / ORDER RECEIVED</div><h1>THANK YOU.</h1><p>Your payment is confirmed. Stripe has emailed your receipt. We’ll be in touch with your order details.</p><a href="/">RETURN HOME</a></main><script>localStorage.removeItem("a2jr-cart")</script></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      return withCors(await createCheckout(request, env), request);
    }
    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/order-confirmed") return confirmationPage();
    return env.ASSETS.fetch(request);
  }
};
