#!/usr/bin/env node
/**
 * Klutch Auto — Dealer Onboarding Script
 * Usage: node scripts/onboard.js
 *
 * Fills in dealer platform credentials for a customer who has already paid.
 * The webhook creates the license key automatically on payment.
 * This script links the license to a dealer config.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const KNOWN_DEALERS = {
  'envisioncdjrwestcovina.com':  { name: 'West Covina CDJR',              platform: 'algolia'   },
  'mbwestcovina.com':            { name: 'Mercedes-Benz of West Covina',   platform: 'foxdealer' },
  'mbofanaheim.com':             { name: 'Mercedes-Benz of Anaheim',       platform: 'algolia'   },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function extractDomain(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

async function getLicense(email) {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('subscriber_email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

async function findDealer(websiteUrl) {
  const { data } = await supabase
    .from('dealers')
    .select('id, name, platform')
    .eq('website_url', websiteUrl)
    .limit(1)
    .single();
  return data || null;
}

async function insertDealer(dealer) {
  const { data, error } = await supabase
    .from('dealers')
    .insert(dealer)
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function linkLicenseToDealer(licenseId, dealerId) {
  const { error } = await supabase
    .from('licenses')
    .update({ dealer_id: dealerId })
    .eq('id', licenseId);
  if (error) throw error;
}

// ─── Platform credential collectors ──────────────────────────────────────────

async function collectAlgolia(name, location, url) {
  console.log('\n  Algolia credentials (find in Network tab → filter "algolia" → POST request headers)');
  const appId   = await ask('  App ID:      ');
  const apiKey  = await ask('  API Key:     ');
  const index   = await ask('  Index name:  ');
  return {
    name, location, platform: 'algolia', website_url: url,
    algolia_app_id: appId.trim(),
    algolia_api_key: apiKey.trim(),
    algolia_index: index.trim(),
    algolia_filters: [['type:Certified Used', 'type:Used']],
    is_active: true,
  };
}

async function collectFoxDealer(name, location, url) {
  console.log('\n  FoxDealer credentials (find in Network tab → Fetch/XHR → n2o.foxdealer.com → blog_id= in URL)');
  const blogId = await ask('  Blog ID:  ');
  return {
    name, location, platform: 'foxdealer', website_url: url,
    foxdealer_blog_id: blogId.trim(),
    is_active: true,
  };
}

async function collectDealerOn(name, location, url) {
  console.log('\n  DealerOn credentials (find in Network tab → inventoryphotos path → the number in the path)');
  const photoId = await ask('  Photo ID (dealer_id_external):  ');
  return {
    name, location, platform: 'dealercom', website_url: url,
    dealer_id_external: photoId.trim(),
    is_active: true,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n┌─────────────────────────────────────┐');
  console.log('│   Klutch Auto — Dealer Onboarding   │');
  console.log('└─────────────────────────────────────┘\n');

  // Step 1 — Customer email
  const email = (await ask('Customer email: ')).trim().toLowerCase();

  // Step 2 — Look up license
  const license = await getLicense(email);
  if (!license) {
    console.error(`\n❌ No license found for ${email}.`);
    console.error('   Either payment hasn\'t gone through or the webhook hasn\'t fired yet.');
    rl.close(); return;
  }
  if (!license.is_active) {
    console.error(`\n⚠️  License found but is_active = false. Check Stripe payment for ${email}.`);
    rl.close(); return;
  }
  console.log(`\n✓ License found: ${license.license_key}`);
  console.log(`  Subscriber:    ${license.subscriber_name}`);
  console.log(`  Expires:       ${new Date(license.expires_at).toLocaleDateString()}`);

  if (license.dealer_id) {
    const confirm = await ask('\n  Dealer already linked. Re-onboard anyway? (y/N): ');
    if (confirm.toLowerCase() !== 'y') { rl.close(); return; }
  }

  // Step 3 — Dealer website URL
  const rawUrl    = await ask('\nDealer website URL: ');
  const websiteUrl = normalizeUrl(rawUrl);
  const domain     = extractDomain(websiteUrl);

  // Check if dealer already exists
  let dealerId = null;
  const existing = await findDealer(websiteUrl);
  if (existing) {
    console.log(`\n✓ Dealer already in Supabase: ${existing.name} (${existing.platform})`);
    dealerId = existing.id;
  } else {
    // Check known dealers
    const known = KNOWN_DEALERS[domain];

    const name     = known?.name     || (await ask('\nDealer name:      ')).trim();
    const location = await ask('Location (City, ST): ');

    let platform = known?.platform;
    if (!platform) {
      console.log('\nPlatform options: algolia | foxdealer | dealercom');
      console.log('Not sure? → Open dealer site in Chrome → F12 → Network tab → filter "algolia" → refresh');
      console.log('           → If no algolia hits, check Fetch/XHR for n2o.foxdealer.com');
      console.log('           → If footer says "Powered by DealerOn" → dealercom');
      platform = (await ask('Platform: ')).trim().toLowerCase();
    }

    let dealerData;
    if      (platform === 'algolia')   dealerData = await collectAlgolia(name, location.trim(), websiteUrl);
    else if (platform === 'foxdealer') dealerData = await collectFoxDealer(name, location.trim(), websiteUrl);
    else if (platform === 'dealercom') dealerData = await collectDealerOn(name, location.trim(), websiteUrl);
    else {
      console.error(`\n❌ Unknown platform: ${platform}`);
      rl.close(); return;
    }

    console.log('\n  Inserting dealer into Supabase...');
    try {
      dealerId = await insertDealer(dealerData);
      console.log(`  ✓ Dealer inserted (id: ${dealerId})`);
    } catch (err) {
      console.error('\n❌ Dealer insert failed:', err.message);
      rl.close(); return;
    }
  }

  // Step 4 — Link license to dealer
  try {
    await linkLicenseToDealer(license.id, dealerId);
    console.log('  ✓ License linked to dealer');
  } catch (err) {
    console.error('\n❌ License link failed:', err.message);
    rl.close(); return;
  }

  // Step 5 — Output
  const firstName = license.subscriber_name.split(' ')[0];
  const expiryDate = new Date(license.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║          ✅  CUSTOMER ONBOARDED          ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Name:     ${license.subscriber_name.padEnd(30)} ║`);
  console.log(`║  Email:    ${email.padEnd(30)} ║`);
  console.log(`║  Expires:  ${expiryDate.padEnd(30)} ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  LICENSE KEY:                            ║`);
  console.log(`║  ${license.license_key}  ║`);
  console.log('╚══════════════════════════════════════════╝');

  console.log(`
────────────────────────────────────────────
ACTIVATION EMAIL (copy & send):
────────────────────────────────────────────
Subject: Your Klutch Auto License Key

Hey ${firstName},

You're all set! Here's your Klutch Auto license key:

${license.license_key}

SETUP STEPS:
1. Unzip the extension file I'll attach
2. Open Chrome → chrome://extensions
3. Enable Developer Mode (top right toggle)
4. Click "Load unpacked" → select the unzipped folder
5. Pin the extension (puzzle piece → pin)
6. Click the Klutch icon → enter your key → Activate
7. Hit Refresh — your inventory loads automatically
8. Go to Facebook Marketplace → Create Listing → Autofill ✓

Your license renews automatically with your subscription.
If you ever need to re-activate, just re-enter the same key.

Questions? Reply to this email.

— Liam | Klutch Auto
────────────────────────────────────────────
`);

  rl.close();
}

main().catch(err => {
  console.error('\nUnexpected error:', err);
  rl.close();
  process.exit(1);
});
