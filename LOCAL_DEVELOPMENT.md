# Local Development Setup

This guide will help you set up the Sonos Controller for local development and testing.

## Prerequisites

1. Node.js 18+ installed
2. A Supabase project (see `DEPLOYMENT.md` for setup instructions)
3. Sonos API credentials (Client ID and Secret) from https://developer.sonos.com

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Set Up Environment Variables

1. Copy the template file to create your `.env` file:

   ```bash
   cp env.template .env
   ```

2. Edit `.env` and fill in your actual values:
   - `SONOS_CLIENT_ID` - Your Sonos Client ID from developer.sonos.com
   - `SONOS_CLIENT_SECRET` - Your Sonos Client Secret from developer.sonos.com
   - `REDIRECT_URI` - Set to `http://localhost:3000/auth/sonos/callback` for local development
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_KEY` - Your Supabase service_role key (NOT the anon key)

## Step 3: Configure Sonos Redirect URI

**CRITICAL**: You must register the local redirect URI in your Sonos Developer account:

1. Go to https://developer.sonos.com
2. Log in and navigate to your app/credentials
3. Find the "Redirect URIs" or "Allowed Redirect URIs" section
4. Add `http://localhost:3000/auth/sonos/callback` to the list of allowed redirect URIs
5. Save the changes

**Note**: Sonos may allow multiple redirect URIs, so you can have both:

- `http://localhost:3000/auth/sonos/callback` (for local development)
- `https://your-app.netlify.app/auth/sonos/callback` (for production)

## Step 4: Set Up Supabase Database

1. Go to your Supabase project dashboard
2. Navigate to the SQL Editor
3. Run the SQL script from `supabase-schema.sql` to create the required tables

## Step 5: Start the Development Server

```bash
npm run dev
```

The server will start on `http://localhost:3000` (or the port specified in your `PORT` environment variable).

## Step 6: Test the Application

1. Open your browser and navigate to `http://localhost:3000`
2. Click "Login with Sonos" to authenticate
3. You should be redirected to Sonos to authorize the app
4. After authorization, you'll be redirected back to `http://localhost:3000/auth/sonos/callback`

## Troubleshooting

### Error: "Missing Sonos configuration in environment variables"

- Make sure you've created a `.env` file (not just `env.template`)
- Verify all required environment variables are set and not using placeholder values
- Check that there are no typos in variable names

### Error: "Invalid redirect_uri" from Sonos

- Verify that `http://localhost:3000/auth/sonos/callback` is registered in your Sonos Developer account
- Check that the `REDIRECT_URI` in your `.env` file exactly matches what's registered (including `http://` vs `https://`)
- Make sure there are no trailing slashes or extra characters

### Error: "Database table missing"

- Make sure you've run the SQL migration from `supabase-schema.sql` in your Supabase SQL Editor
- Verify your `SUPABASE_URL` and `SUPABASE_KEY` are correct
- Check that you're using the `service_role` key, not the `anon` key

### OAuth URL shows placeholder values

- This means your `.env` file is not being loaded or doesn't exist
- Make sure `.env` is in the root directory of the project
- Verify the file is named exactly `.env` (not `.env.local` or `.env.example`)
- Restart the server after creating or modifying `.env`

## Environment Variables Reference

See `env.template` for a complete list of all environment variables and their descriptions.
