/**
 * YARAÏ — server.js
 * Backend : paiement (Stripe + PayDunya) + base de données (Prisma/PostgreSQL)
 */

const express            = require("express");
const axios              = require("axios");
const { Pool }           = require("pg");
const { PrismaPg }       = require("@prisma/adapter-pg");
const { PrismaClient }   = require("@prisma/client");
require("dotenv").config();

const app     = express();
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// Servir les fichiers statiques du frontend (même serveur = pas de CORS)
app.use(express.static(__dirname));
app.use(express.json());

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const PAYDUNYA_BASE = process.env.PAYDUNYA_MODE === "test"
  ? "https://app.paydunya.com/sandbox-api/v1"
  : "https://app.paydunya.com/api/v1";

const paydunyaHeaders = {
  "PAYDUNYA-MASTER-KEY":  process.env.PAYDUNYA_MASTER_KEY,
  "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
  "PAYDUNYA-TOKEN":       process.env.PAYDUNYA_TOKEN,
  "Content-Type": "application/json",
};

/* ══════════════════════════════════════════════════════════════
   STOCK
══════════════════════════════════════════════════════════════ */

// GET /api/stock?productId=skirt-safia
// Retourne le stock disponible pour un produit (toutes variantes + tailles)
app.get("/api/stock", async (req, res) => {
  try {
    const { productId } = req.query;
    const where = productId ? { productId } : {};
    const stocks = await prisma.stock.findMany({ where });
    res.json(stocks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/check — vérifie disponibilité avant de payer
// Body: [{ productId, variant, size, qty }]
app.post("/api/stock/check", async (req, res) => {
  try {
    const items = req.body.items;
    const unavailable = [];

    for (const item of items) {
      const stock = await prisma.stock.findUnique({
        where: { productId_variant_size: { productId: item.productId, variant: item.variant, size: item.size } },
      });
      if (!stock || stock.qty < item.qty) {
        unavailable.push({ ...item, available: stock?.qty ?? 0 });
      }
    }

    if (unavailable.length > 0) {
      return res.status(409).json({ ok: false, unavailable });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   STRIPE
══════════════════════════════════════════════════════════════ */

app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { amount, customer_name, customer_email, customer_phone, items } = req.body;

    // Vérifier le stock avant de créer le paiement
    if (items) {
      for (const item of items) {
        const stock = await prisma.stock.findUnique({
          where: { productId_variant_size: { productId: item.productId, variant: item.variant, size: item.size } },
        });
        if (!stock || stock.qty < item.qty) {
          return res.status(409).json({ error: `Stock insuffisant : ${item.productId} / ${item.variant} / ${item.size}` });
        }
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(amount),
      currency: "xof",
      description: "Commande YARAÏ",
      receipt_email: customer_email,
      metadata: { customer_name, customer_phone },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook Stripe — déclenché quand le paiement est confirmé
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send("Webhook Error: " + err.message);
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    await confirmOrder(intent.id, "card", intent.metadata);
  }

  res.json({ received: true });
});

/* ══════════════════════════════════════════════════════════════
   PAYDUNYA — Wave, Orange Money, Free Money
══════════════════════════════════════════════════════════════ */

// POST /api/paydunya/create — crée une facture et retourne l'URL de paiement
app.post("/api/paydunya/create", async (req, res) => {
  try {
    const { amount, channel, customer_name, customer_email, customer_phone, items } = req.body;

    const response = await axios.post(`${PAYDUNYA_BASE}/checkout-invoice/create`, {
      invoice: {
        total_amount: Math.round(amount),
        description:  "Commande YARAÏ",
        items:        items || [],
      },
      store: {
        name:           "YARAÏ",
        tagline:        "Simplement Belle",
        postal_address: "Dakar, Sénégal",
        phone:          process.env.STORE_PHONE || "",
        website_url:    process.env.FRONTEND_URL || "",
      },
      actions: {
        cancel_url:   `${process.env.FRONTEND_URL || "http://localhost:5500"}/#/checkout`,
        return_url:   `${process.env.FRONTEND_URL || "http://localhost:5500"}/#/confirmation`,
        callback_url: `${process.env.BACKEND_URL  || "http://localhost:3000"}/api/paydunya/notify`,
      },
      custom_data: {
        customer_name,
        customer_email,
        customer_phone,
        channel,
      },
    }, { headers: paydunyaHeaders });

    const data = response.data;
    if (data.response_code !== "00") {
      return res.status(400).json({ error: data.response_text || "Échec création facture PayDunya" });
    }

    console.log("PayDunya invoice créée:", data.token);
    res.json({ checkout_url: data.response_text, token: data.token });

  } catch (err) {
    console.error("PayDunya create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/paydunya/verify — vérifie le statut d'un paiement (appelé par le frontend au retour)
app.post("/api/paydunya/verify", async (req, res) => {
  const { token } = req.body;
  try {
    const response = await axios.get(`${PAYDUNYA_BASE}/checkout-invoice/confirm/${token}`, {
      headers: paydunyaHeaders,
    });
    const data = response.data;
    const status = data.status; // "completed" | "pending" | "cancelled"

    if (status === "completed") {
      await confirmOrder(token, "mobile_money", {});
    }

    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/paydunya/notify — webhook IPN (appelé automatiquement par PayDunya)
app.post("/api/paydunya/notify", async (req, res) => {
  const { data } = req.body;
  const token = data?.invoice?.token;
  console.log("PayDunya IPN reçu:", token);
  if (token) await confirmOrder(token, "mobile_money", {});
  res.sendStatus(200);
});

/* ══════════════════════════════════════════════════════════════
   COMMANDES
══════════════════════════════════════════════════════════════ */

// POST /api/orders — créer une commande (avant paiement)
app.post("/api/orders", async (req, res) => {
  try {
    const { customer, items, paymentMethod } = req.body;
    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);

    // Upsert client
    const dbCustomer = await prisma.customer.upsert({
      where:  { email: customer.email },
      update: { name: customer.name, phone: customer.phone, city: customer.city, address: customer.address, country: customer.country },
      create: { name: customer.name, email: customer.email, phone: customer.phone, city: customer.city, address: customer.address, country: customer.country },
    });

    // Créer commande
    const reference = "YARAI-" + Date.now().toString(36).toUpperCase();
    const order = await prisma.order.create({
      data: {
        reference,
        total,
        paymentMethod,
        customerId: dbCustomer.id,
        items: {
          create: items.map(i => ({
            productId: i.productId,
            variant:   i.variant,
            size:      i.size,
            qty:       i.qty,
            price:     i.price,
          })),
        },
      },
      include: { items: true },
    });

    res.json({ orderId: order.id, reference: order.reference });
  } catch (err) {
    console.error("Order error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders — liste toutes les commandes (admin)
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: { customer: true, items: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   FONCTION INTERNE — confirmation de commande
   Appelée par les webhooks Stripe et CinetPay
══════════════════════════════════════════════════════════════ */
async function confirmOrder(paymentId, method, metadata) {
  try {
    // Trouver la commande par paymentId ou référence dans les métadonnées
    const order = await prisma.order.findFirst({
      where: { OR: [{ paymentId }, { reference: metadata?.reference }] },
      include: { items: true },
    });

    if (!order || order.status === "PAID") return;

    // Marquer comme payée
    await prisma.order.update({
      where: { id: order.id },
      data:  { status: "PAID", paymentId },
    });

    // Décrémenter le stock pour chaque article
    for (const item of order.items) {
      await prisma.stock.updateMany({
        where: {
          productId: item.productId,
          variant:   item.variant,
          size:      item.size,
        },
        data: { qty: { decrement: item.qty } },
      });
    }

    console.log(`✅ Commande ${order.reference} confirmée — stock mis à jour`);
  } catch (err) {
    console.error("confirmOrder error:", err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════════════════════════ */
// Toutes les routes non-API renvoient index.html (SPA)
app.get("/health", (_req, res) => res.json({ status: "YARAÏ server OK" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ YARAÏ server démarré sur http://localhost:${PORT}`));
