// ============================================================================
// Supabase Client with Environment Validation & Demo Sandbox Fallback
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isLiveSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey && 
  !supabaseUrl.includes('placeholder')
);

// Explicit Interactive Demo Mode Flag
export const isDemoMode = !isLiveSupabaseConfigured || import.meta.env.VITE_DEMO_MODE === 'true';

// Standard Supabase client (only uses public/anon key, never service role key!)
export const supabase = isLiveSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;
