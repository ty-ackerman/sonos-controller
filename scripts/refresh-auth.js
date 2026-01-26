/**
 * Automated Sonos OAuth refresh script
 * 
 * This script uses Playwright to automate the Sonos OAuth flow,
 * refreshing the authentication tokens stored in Supabase.
 * 
 * Required environment variables:
 * - SONOS_EMAIL: Sonos account email
 * - SONOS_PASSWORD: Sonos account password
 * - APP_URL: The deployed app URL (default: https://sonos-controller.netlify.app)
 * 
 * Optional environment variables:
 * - HEADLESS: Set to 'false' to see the browser (default: true)
 * - SLOW_MO: Milliseconds to slow down actions for debugging (default: 0)
 */

import { chromium } from 'playwright';

const SONOS_EMAIL = process.env.SONOS_EMAIL;
const SONOS_PASSWORD = process.env.SONOS_PASSWORD;
const APP_URL = process.env.APP_URL || 'https://sonos-controller.netlify.app';
const HEADLESS = process.env.HEADLESS !== 'false';
const SLOW_MO = process.env.SLOW_MO ? parseInt(process.env.SLOW_MO) : 0;

// Use a fixed device ID for global/shared authentication
const GLOBAL_DEVICE_ID = 'global-automation';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshAuth() {
  console.log('🚀 Starting Sonos authentication refresh...');
  console.log(`📍 App URL: ${APP_URL}`);
  console.log(`🔑 Device ID: ${GLOBAL_DEVICE_ID}`);
  console.log(`👁️ Headless: ${HEADLESS}`);

  if (!SONOS_EMAIL || !SONOS_PASSWORD) {
    console.error('❌ Missing required environment variables: SONOS_EMAIL and SONOS_PASSWORD');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: SLOW_MO,
  });

  const context = await browser.newContext({
    // Use a fresh context (like incognito) - no stored cookies/localStorage
    storageState: undefined,
  });

  const page = await context.newPage();

  try {
    // Step 1: Navigate to the app's OAuth login endpoint
    console.log('\n📱 Step 1: Initiating OAuth flow...');
    const loginUrl = `${APP_URL}/auth/sonos/login?device_id=${encodeURIComponent(GLOBAL_DEVICE_ID)}`;
    console.log(`   Navigating to: ${loginUrl}`);
    
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000); // Wait for any redirects
    console.log(`   Current URL: ${page.url()}`);

    // Step 2: Handle any intermediate pages
    console.log('\n📋 Step 2: Handling intermediate pages...');
    
    let maxAttempts = 5;
    while (maxAttempts > 0) {
      const currentUrl = page.url();
      console.log(`   Checking page: ${currentUrl}`);
      
      // Check for "Before you get started" / Continue button (it's an input, not a button)
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
          // Navigate back to login
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
        console.log('   Found authorization page (already logged in), clicking Okay...');
        await okayButton.click();
        await page.waitForLoadState('networkidle');
        await sleep(2000);
        
        // Check if we're done
        if (page.url().includes('auth=success') || page.url().includes(APP_URL)) {
          console.log('\n✅ Authentication completed (was already logged in)!');
          console.log(`   Tokens have been saved to Supabase with device_id: ${GLOBAL_DEVICE_ID}`);
          return; // Success!
        }
        maxAttempts--;
        continue;
      }
      
      // Check if we reached the app successfully
      if (page.url().includes('auth=success')) {
        console.log('\n✅ Authentication completed!');
        return;
      }
      
      console.log('   Waiting for page to load...');
      await sleep(2000);
      maxAttempts--;
    }

    // Step 3: Fill in Sonos login credentials
    console.log('\n🔐 Step 3: Entering credentials...');
    
    // Wait for the login form with longer timeout
    const emailInput = page.locator('input[placeholder="Enter your email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    
    // Fill email
    console.log('   Filling email...');
    await emailInput.fill(SONOS_EMAIL);
    
    // Fill password
    console.log('   Filling password...');
    const passwordInput = page.locator('input[placeholder="Enter your password"]');
    await passwordInput.fill(SONOS_PASSWORD);
    
    // Click sign in (it's an input, not a button)
    console.log('   Clicking Sign in...');
    const signInButton = page.locator('input[type="submit"][value="Sign in"]');
    await signInButton.click();
    
    // Wait for navigation
    await page.waitForLoadState('networkidle');
    await sleep(2000);
    console.log(`   Current URL: ${page.url()}`);

    // Step 4: Handle OAuth authorization page
    console.log('\n✅ Step 4: Handling authorization...');
    
    // Check if we're on the authorization page
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
      console.log('\n✅ Authentication refresh completed successfully!');
      console.log(`   Tokens have been saved to Supabase with device_id: ${GLOBAL_DEVICE_ID}`);
    } else if (page.url().includes('auth=')) {
      const url = new URL(page.url());
      const authStatus = url.searchParams.get('auth');
      console.error(`\n❌ Authentication failed with status: ${authStatus}`);
      
      // Take screenshot
      await page.screenshot({ path: 'auth-error-screenshot.png', fullPage: true });
      console.log('   Screenshot saved to: auth-error-screenshot.png');
      process.exit(1);
    } else {
      console.warn('\n⚠️  Unexpected final URL, taking screenshot for debugging...');
      await page.screenshot({ path: 'auth-unexpected-screenshot.png', fullPage: true });
      console.log('   Screenshot saved to: auth-unexpected-screenshot.png');
    }

  } catch (error) {
    console.error('\n❌ Error during authentication:', error.message);
    
    // Take a screenshot for debugging
    try {
      await page.screenshot({ path: 'auth-error-screenshot.png', fullPage: true });
      console.log('   Screenshot saved to: auth-error-screenshot.png');
    } catch (screenshotError) {
      console.log('   Could not save screenshot:', screenshotError.message);
    }
    
    process.exit(1);
  } finally {
    await browser.close();
    console.log('\n🔒 Browser closed');
  }
}

// Run the script
refreshAuth();
