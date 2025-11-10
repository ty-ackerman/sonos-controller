import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const envPath = join(__dirname, '.env');
  const envTemplatePath = join(__dirname, 'env.template');
  
  let message = 'Missing Supabase configuration: SUPABASE_URL and SUPABASE_KEY are required\n\n';
  
  if (!existsSync(envPath)) {
    message += `No .env file found. Please create one based on env.template:\n`;
    message += `  cp env.template .env\n\n`;
  }
  
  message += `Then edit .env and add your Supabase credentials:\n`;
  message += `  - SUPABASE_URL: Get from your Supabase project (Settings > API)\n`;
  message += `  - SUPABASE_KEY: Use the "service_role" key (not the anon key)\n\n`;
  message += `See env.template for more details.`;
  
  throw new Error(message);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

