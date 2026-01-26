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
 */

import { chromium } from 'playwright';

const SONOS_EMAIL = process.env.SONOS_EMAIL;
const SONOS_PASSWORD = process.env.SONOS_PASSWORD;
const APP_URL = process.env.APP_URL || 'https://sonos-controller.netlify.app';

// Use a fixed device ID for global/shared authentication
const GLOBAL_DEVICE_ID = 'global-automation';

async function refreshAuth() {
  console.log('🚀 Starting Sonos authentication refresh...');
  console.log(`📍 App URL: ${APP_URL}`);
  console.log(`🔑 Device ID: ${GLOBAL_DEVICE_ID}`);

  if (!SONOS_EMAIL || !SONOS_PASSWORD) {
    console.error('❌ Missing required environment variables: SONOS_EMAIL and SONOS_PASSWORD');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    // Use a fresh context (like incognito) - no stored cookies/localStorage
    storageState: undefined,
  });

  const page = await context.newPage();

  try {
    // Step 1: Navigate to the app's OAuth login endpoint with global device ID
    console.log('\n📱 Step 1: Initiating OAuth flow...');
    const loginUrl = `${APP_URL}/auth/sonos/login?device_id=${encodeURIComponent(GLOBAL_DEVICE_ID)}`;
    console.log(`   Navigating to: ${loginUrl}`);
    
    await page.goto(loginUrl, { waitUntil: 'networkidle' });
    console.log(`   Current URL: ${page.url()}`);

    // Step 2: Handle "Before you get started" page if it appears
    if (page.url().includes('api.sonos.com/login/v3/oauth')) {
      console.log('\n📋 Step 2: Checking for pre-auth page...');
      const continueButton = page.locator('button:has-text("Continue")');
      if (await continueButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('   Found "Continue" button, clicking...');
        await continueButton.click();
        await page.waitForLoadState('networkidle');
      }
    }

    // Step 3: Fill in Sonos login credentials
    console.log('\n🔐 Step 3: Entering credentials...');
    
    // Wait for the login form
    await page.waitForSelector('input[placeholder="Enter your email"]', { timeout: 10000 });
    
    // Fill email
    console.log('   Filling email...');
    await page.fill('input[placeholder="Enter your email"]', SONOS_EMAIL);
    
    // Fill password
    console.log('   Filling password...');
    await page.fill('input[placeholder="Enter your password"]', SONOS_PASSWORD);
    
    // Click sign in
    console.log('   Clicking Sign in...');
    await page.click('button:has-text("Sign in")');
    
    // Wait for navigation
    await page.waitForLoadState('networkidle');
    console.log(`   Current URL: ${page.url()}`);

    // Step 4: Handle OAuth authorization page
    console.log('\n✅ Step 4: Handling authorization...');
    
    // Check if we're on the authorization page
    if (page.url().includes('oauth/authorize')) {
      console.log('   Found authorization page, clicking "Okay"...');
      const okayButton = page.locator('button:has-text("Okay")');
      await okayButton.waitFor({ timeout: 10000 });
      await okayButton.click();
      await page.waitForLoadState('networkidle');
    }

    // Step 5: Verify success
    console.log('\n🎉 Step 5: Verifying success...');
    console.log(`   Final URL: ${page.url()}`);
    
    if (page.url().includes('auth=success') || page.url().includes(APP_URL)) {
      console.log('\n✅ Authentication refresh completed successfully!');
      console.log(`   Tokens have been saved to Supabase with device_id: ${GLOBAL_DEVICE_ID}`);
    } else if (page.url().includes('auth=')) {
      // Check for error in URL
      const url = new URL(page.url());
      const authStatus = url.searchParams.get('auth');
      console.error(`\n❌ Authentication failed with status: ${authStatus}`);
      process.exit(1);
    } else {
      console.warn('\n⚠️  Unexpected final URL, please verify authentication manually');
    }

  } catch (error) {
    console.error('\n❌ Error during authentication:', error.message);
    
    // Take a screenshot for debugging
    const screenshotPath = 'auth-error-screenshot.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`   Screenshot saved to: ${screenshotPath}`);
    
    process.exit(1);
  } finally {
    await browser.close();
    console.log('\n🔒 Browser closed');
  }
}

// Run the script
refreshAuth();
