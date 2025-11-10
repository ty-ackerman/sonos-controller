# Netlify Deployment Guide

This guide will help you deploy the Sonos Controller to Netlify.

## Prerequisites

1. A Netlify account
2. A Supabase project
3. Sonos API credentials (Client ID and Secret)

## Step 1: Set Up Supabase

1. Create a new Supabase project at https://supabase.com (if you haven't already)
2. Go to the SQL Editor in your Supabase dashboard
3. Run the SQL script from `supabase-schema.sql` to create the required tables:
   - `tokens` - Stores Sonos OAuth tokens
   - `speaker_volumes` - Stores speaker volume settings
   - `playlist_vibes` - Stores playlist vibe settings

## Step 2: Get Your Supabase Credentials

**You're currently looking at the Supabase API Keys page - this is correct!**

From the Supabase API Keys page:

1. **Find SUPABASE_URL**:

   - Look for your Project URL (usually shown at the top of the page or in Settings > API)
   - It looks like: `https://xxxxxxxxxxxxx.supabase.co`
   - Copy this value - you'll need it for Netlify

2. **Find SUPABASE_KEY** (Service Role Key):
   - On the API Keys page, look for the **"Legacy API Keys"** section
   - Find the **"Service Role Secret Key"** (it has a red "secret" tag)
   - Click "Reveal" to see the full key
   - Copy the entire key value - you'll need it for Netlify
   - **Important**: Use the `service_role` key (the secret one), NOT the `anon` key
   - This key bypasses Row Level Security and is needed for server-side operations

**Note**: You're just copying these values from Supabase. You'll add them as environment variables in Netlify (next step).

## Step 3: Configure Netlify Environment Variables

**IMPORTANT: Environment variables are added in Netlify, NOT in Supabase!**

Supabase is just where you **copy** the values from. You'll **paste** them into Netlify.

### Where to Add Environment Variables in Netlify:

1. **Go to your Netlify dashboard** (app.netlify.com)

   - If you haven't created a site yet, you'll do this after deploying (see Step 5)

2. **Navigate to your site** (or create one first)

3. **Go to Site Settings**:

   - Click on your site name
   - Click the **gear icon** (⚙️) or **"Site settings"** in the top navigation

4. **Open Environment Variables**:

   - In the left sidebar, click **"Environment variables"**
   - You should see a page with an **"Add a variable"** or **"Add environment variable"** button

5. **Add each variable** (click "Add a variable" for each one):
   - `SONOS_CLIENT_ID` = (your Sonos Client ID from your Sonos Developer account)
   - `SONOS_CLIENT_SECRET` = (your Sonos Client Secret from your Sonos Developer account)
   - `REDIRECT_URI` = `https://your-app.netlify.app/auth/sonos/callback` (replace `your-app` with your actual Netlify site name)
   - `SUPABASE_URL` = (the URL you copied from Supabase in Step 2)
   - `SUPABASE_KEY` = (the service_role key you copied from Supabase in Step 2)

### Optional Variables:

- `SONOS_HOUSEHOLD_ID` - Only add this if you want to specify a particular Sonos household

### If You Can't Find Environment Variables in Netlify:

- Make sure you're logged into Netlify
- Make sure you've created a site (even if it hasn't been deployed yet)
- Look for "Site settings" or the gear icon (⚙️) in the site dashboard
- The "Environment variables" option should be in the left sidebar under Site settings

**Note**: If you haven't created a Netlify site yet, you can add environment variables during the deployment process (Step 5).

## Step 4: Update Sonos Redirect URI

1. Go to https://developer.sonos.com
2. Find your app credentials
3. Update the Redirect URI to match your Netlify deployment URL:
   - Example: `https://your-app.netlify.app/auth/sonos/callback`
4. Save the changes

## Step 5: Deploy to Netlify

### Option A: Deploy via Git (Recommended)

1. Push your code to GitHub/GitLab/Bitbucket
2. In Netlify, click "Add new site" > "Import an existing project"
3. Connect your repository
4. Netlify will automatically detect the settings from `netlify.toml`:
   - Build command: `npm install`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
5. Add the environment variables (from Step 3)
6. Click "Deploy site"

### Option B: Deploy via Netlify CLI

1. Install Netlify CLI: `npm install -g netlify-cli`
2. Run `netlify deploy --prod`
3. Follow the prompts to link your site
4. Add environment variables via the Netlify dashboard

## Step 6: Verify Deployment

1. Once deployed, visit your Netlify URL
2. Click "Login with Sonos" to authenticate
3. You should be redirected to Sonos to authorize the app
4. After authorization, you'll be redirected back to your app

## Troubleshooting

### Database Connection Issues

- Verify `SUPABASE_URL` and `SUPABASE_KEY` are set correctly
- Make sure you're using the `service_role` key, not the `anon` key
- Check that the SQL schema has been run in Supabase

### Authentication Issues

- Verify `REDIRECT_URI` matches exactly in both Netlify and Sonos Developer portal
- Check that `SONOS_CLIENT_ID` and `SONOS_CLIENT_SECRET` are correct
- Check Netlify function logs for error messages

### Function Timeouts

- Netlify free tier has a 26-second timeout
- Some operations (like autogrouping) might take longer
- Consider upgrading to a paid plan for 60-second timeouts

### Static Files Not Loading

- Verify `publish = "public"` in `netlify.toml`
- Check that `public/index.html` exists
- Check Netlify deploy logs for build errors

## Netlify Settings Summary

Based on `netlify.toml`, your Netlify site should have:

- **Base directory**: (empty)
- **Build command**: `npm install`
- **Publish directory**: `public`
- **Functions directory**: `netlify/functions`

These settings are automatically applied from `netlify.toml`, so you don't need to set them manually in the Netlify UI.

## Environment Variables Template

See `env.template` for a template of all required environment variables.

## Support

If you encounter issues:

1. Check the Netlify function logs in your dashboard
2. Verify all environment variables are set correctly
3. Ensure the Supabase schema has been applied
4. Verify the Sonos Redirect URI matches your deployment URL
