/**
 * Automated Sonos OAuth refresh script - Multi-location support
 * 
 * This script uses Playwright to automate the Sonos OAuth flow,
 * refreshing the authentication tokens for multiple locations.
 * 
 * Required environment variables:
 * - SONOS_EMAIL_COLLEGE: College location Sonos account email
 * - SONOS_PASSWORD_COLLEGE: College location Sonos account password
 * - SONOS_EMAIL_LESLIEVILLE: Leslieville location Sonos account email
 * - SONOS_PASSWORD_LESLIEVILLE: Leslieville location Sonos account password
 * - APP_URL: The deployed app URL (default: https://sonos-controller.netlify.app)
 * 
 * Optional environment variables:
 * - HEADLESS: Set to 'false' to see the browser (default: true)
 * - SLOW_MO: Milliseconds to slow down actions for debugging (default: 0)
 */

import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'https://sonos-controller.netlify.app';
const HEADLESS = process.env.HEADLESS !== 'false';
const SLOW_MO = process.env.SLOW_MO ? parseInt(process.env.SLOW_MO) : 0;

// Location configurations
const LOCATIONS = [
  {
    name: 'College',
    deviceId: 'global-automation-college',
    email: process.env.SONOS_EMAIL_COLLEGE,
    password: process.env.SONOS_PASSWORD_COLLEGE,
  },
  {
    name: 'Leslieville',
    deviceId: 'global-automation-leslieville',
    email: process.env.SONOS_EMAIL_LESLIEVILLE,
    password: process.env.SONOS_PASSWORD_LESLIEVILLE,
  },
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function authenticateLocation(browser, location) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🏢 Authenticating: ${location.name}`);
  console.log(`🔑 Device ID: ${location.deviceId}`);
  console.log('='.repeat(50));

  if (!location.email || !location.password) {
    console.error(`❌ Missing credentials for ${location.name}`);
    return false;
  }

  // Create a fresh context for each location (like incognito)
  const context = await browser.newContext({
    storageState: undefined,
  });

  const page = await context.newPage();

  try {
    // Step 1: Navigate to the app's OAuth login endpoint
    console.log('\n📱 Step 1: Initiating OAuth flow...');
    const loginUrl = `${APP_URL}/auth/sonos/login?device_id=${encodeURIComponent(location.deviceId)}`;
    console.log(`   Navigating to: ${loginUrl}`);
    
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);
    console.log(`   Current URL: ${page.url()}`);

    // Step 2: Handle any intermediate pages
    console.log('\n📋 Step 2: Handling intermediate pages...');
    
    let maxAttempts = 5;
    while (maxAttempts > 0) {
      const currentUrl = page.url();
      console.log(`   Checking page: ${currentUrl}`);
      
      // Check for "Before you get started" / Continue button
      const continueButton = page.locator('input[type="submit"][value="Continue"]');
      if (await continueButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('   Found "Continue" button, clicking...');
        await continueButton.click();
        await page.waitForLoadState('networkidle');
        await sleep(1000);
        maxAttempts--;
        continue;
      }
      
      // Check for "Already signed in" page
      const alreadySignedIn = page.locator('text=already signed in');
      if (await alreadySignedIn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('   Already signed in, looking for logout...');
        const logoutButton = page.locator('button:has-text("Logout")');
        if (await logoutButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await logoutButton.click();
          await page.waitForLoadState('networkidle');
          await sleep(1000);
          await page.goto(loginUrl, { waitUntil: 'networkidle' });
          await sleep(1000);
        }
        maxAttempts--;
        continue;
      }
      
      // Check if we're on the login form
      const emailInput = page.locator('input[placeholder="Enter your email"]');
      if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('   Found login form!');
        break;
      }
      
      // Check if we're on the authorization page (already logged in)
      const okayButton = page.locator('button:has-text("Okay")');
      if (await okayButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('   Found authorization page, clicking Okay...');
        await okayButton.click();
        await page.waitForLoadState('networkidle');
        await sleep(2000);
        
        if (page.url().includes('auth=success') || page.url().includes(APP_URL)) {
          console.log(`\n✅ ${location.name} authentication completed (was already logged in)!`);
          await context.close();
          return true;
        }
        maxAttempts--;
        continue;
      }
      
      if (page.url().includes('auth=success')) {
        console.log(`\n✅ ${location.name} authentication completed!`);
        await context.close();
        return true;
      }
      
      console.log('   Waiting for page to load...');
      await sleep(2000);
      maxAttempts--;
    }

    // Step 3: Fill in Sonos login credentials
    console.log('\n🔐 Step 3: Entering credentials...');
    
    const emailInput = page.locator('input[placeholder="Enter your email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    
    console.log('   Filling email...');
    await emailInput.fill(location.email);
    
    console.log('   Filling password...');
    const passwordInput = page.locator('input[placeholder="Enter your password"]');
    await passwordInput.fill(location.password);
    
    console.log('   Clicking Sign in...');
    const signInButton = page.locator('input[type="submit"][value="Sign in"]');
    await signInButton.click();
    
    await page.waitForLoadState('networkidle');
    await sleep(2000);
    console.log(`   Current URL: ${page.url()}`);

    // Step 4: Handle OAuth authorization page
    console.log('\n✅ Step 4: Handling authorization...');
    
    if (page.url().includes('oauth/authorize') || page.url().includes('api.sonos.com')) {
      const okayButton = page.locator('button:has-text("Okay")');
      if (await okayButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('   Found authorization page, clicking "Okay"...');
        await okayButton.click();
        await page.waitForLoadState('networkidle');
        await sleep(2000);
      }
    }

    // Step 5: Verify success
    console.log('\n🎉 Step 5: Verifying success...');
    console.log(`   Final URL: ${page.url()}`);
    
    if (page.url().includes('auth=success') || (page.url().includes(APP_URL) && !page.url().includes('auth='))) {
      console.log(`\n✅ ${location.name} authentication completed successfully!`);
      console.log(`   Tokens saved with device_id: ${location.deviceId}`);
      await context.close();
      return true;
    } else if (page.url().includes('auth=')) {
      const url = new URL(page.url());
      const authStatus = url.searchParams.get('auth');
      console.error(`\n❌ ${location.name} authentication failed with status: ${authStatus}`);
      await page.screenshot({ path: `auth-error-${location.name.toLowerCase()}.png`, fullPage: true });
      await context.close();
      return false;
    } else {
      console.warn(`\n⚠️  ${location.name}: Unexpected final URL`);
      await page.screenshot({ path: `auth-unexpected-${location.name.toLowerCase()}.png`, fullPage: true });
      await context.close();
      return false;
    }

  } catch (error) {
    console.error(`\n❌ Error authenticating ${location.name}:`, error.message);
    try {
      await page.screenshot({ path: `auth-error-${location.name.toLowerCase()}.png`, fullPage: true });
      console.log(`   Screenshot saved to: auth-error-${location.name.toLowerCase()}.png`);
    } catch (e) {
      // Ignore screenshot errors
    }
    await context.close();
    return false;
  }
}

async function refreshAuth() {
  console.log('🚀 Starting Sonos authentication refresh (Multi-location)...');
  console.log(`📍 App URL: ${APP_URL}`);
  console.log(`👁️ Headless: ${HEADLESS}`);
  console.log(`📍 Locations: ${LOCATIONS.map(l => l.name).join(', ')}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: SLOW_MO,
  });

  const results = [];

  for (const location of LOCATIONS) {
    const success = await authenticateLocation(browser, location);
    results.push({ location: location.name, success });
  }

  await browser.close();
  console.log('\n🔒 Browser closed');

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 SUMMARY');
  console.log('='.repeat(50));
  
  let allSuccess = true;
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.location}: ${result.success ? 'Success' : 'Failed'}`);
    if (!result.success) allSuccess = false;
  }

  if (!allSuccess) {
    console.error('\n❌ Some locations failed to authenticate');
    process.exit(1);
  }

  console.log('\n✅ All locations authenticated successfully!');
}

// Run the script
refreshAuth();
