const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Read raw body for Stripe signature verification
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

// New purchase via Payment Link
async function onCheckoutComplete(session) {
  const email = session.customer_details?.email || session.customer_email;
  const name  = session.customer_details?.name  || 'Customer';
  if (!email) return console.error('No email on checkout session');

  // Get subscription details for expiry
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const expiresAt    = new Date(subscription.current_period_end * 1000).toISOString();

  // Check for existing license (avoid duplicates)
  const { data: existing } = await supabase
    .from('licenses')
    .select('id, license_key')
    .eq('subscriber_email', email)
    .eq('is_active', true)
    .limit(1)
    .single();

  if (existing) {
    console.log(`License already exists for ${email}, skipping insert.`);
    return;
  }

  // Insert new license (dealer_id null until onboard script fills it)
  const { error } = await supabase.from('licenses').insert({
    subscriber_name:        name,
    subscriber_email:       email,
    expires_at:             expiresAt,
    is_active:              true,
    stripe_customer_id:     session.customer,
    stripe_subscription_id: session.subscription,
  });

  if (error) return console.error('License insert error:', error);

  // Retrieve the generated key
  const { data: license } = await supabase
    .from('licenses')
    .select('license_key, expires_at')
    .eq('subscriber_email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  console.log(`✅ License created for ${email}: ${license.license_key}`);
  await sendActivationEmail(name, email, license.license_key);
}

// Subscription renewed — extend expiry
async function onPaymentSucceeded(invoice) {
  if (!invoice.subscription) return;

  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const expiresAt    = new Date(subscription.current_period_end * 1000).toISOString();

  const { error } = await supabase
    .from('licenses')
    .update({ expires_at: expiresAt, is_active: true })
    .eq('stripe_subscription_id', invoice.subscription);

  if (error) console.error('Renewal update error:', error);
  else console.log(`🔄 Renewed subscription ${invoice.subscription} until ${expiresAt}`);
}

// Payment failed — deactivate
async function onPaymentFailed(invoice) {
  if (!invoice.subscription) return;

  const { error } = await supabase
    .from('licenses')
    .update({ is_active: false })
    .eq('stripe_subscription_id', invoice.subscription);

  if (error) console.error('Payment failed update error:', error);
  else console.log(`❌ Deactivated license for subscription ${invoice.subscription} (payment failed)`);
}

// Subscription canceled — deactivate
async function onSubscriptionDeleted(subscription) {
  const { error } = await supabase
    .from('licenses')
    .update({ is_active: false })
    .eq('stripe_subscription_id', subscription.id);

  if (error) console.error('Cancellation update error:', error);
  else console.log(`🚫 Canceled license for subscription ${subscription.id}`);
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendActivationEmail(name, email, licenseKey) {
  const firstName = name.split(' ')[0];

  if (!resend) {
    console.log(`\n📧 EMAIL (not sent — no RESEND_API_KEY):\nTo: ${email}\nKey: ${licenseKey}\n`);
    return;
  }

  const { error } = await resend.emails.send({
    from:    process.env.RESEND_FROM || 'Klutch Auto <onboarding@klutchauto.us>',
    to:      email,
    subject: 'Your Klutch Auto License Key',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <h2 style="font-size:22px;margin-bottom:8px;">Hey ${firstName}, you're all set!</h2>
        <p>Here's your Klutch Auto license key:</p>
        <div style="background:#f4f4f4;border-radius:8px;padding:16px 20px;margin:20px 0;font-family:monospace;font-size:16px;letter-spacing:0.05em;word-break:break-all;">
          ${licenseKey}
        </div>
        <p style="font-weight:600;margin-bottom:8px;">Setup steps:</p>
        <ol style="line-height:1.8;padding-left:20px;">
          <li>Unzip the extension file I'll attach</li>
          <li>Open Chrome → <code>chrome://extensions</code></li>
          <li>Enable <strong>Developer Mode</strong> (top right toggle)</li>
          <li>Click <strong>Load unpacked</strong> → select the unzipped folder</li>
          <li>Pin the extension (puzzle piece → pin)</li>
          <li>Click the Klutch icon → enter your key → <strong>Activate</strong></li>
          <li>Hit Refresh — your inventory loads automatically</li>
          <li>Go to Facebook Marketplace → Create Listing → Autofill ✓</li>
        </ol>
        <p>Your license renews automatically with your subscription.<br>
        If you ever need to re-activate, just re-enter the same key.</p>
        <p>Questions? Reply to this email.</p>
        <p style="color:#666;">— Liam | Klutch Auto</p>
      </div>
    `,
  });

  if (error) console.error('Email send error:', error);
  else console.log(`📧 Activation email sent to ${email}`);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutComplete(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await onPaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await onPaymentFailed(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(event.data.object);
        break;
      default:
        console.log(`Unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).send('Internal error');
  }

  res.json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
