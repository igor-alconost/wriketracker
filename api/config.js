// Vercel serverless function: GET /api/config
// Exposes the PUBLIC Supabase settings the browser needs for login.
// (The anon key is designed to be public; real security comes from
//  sign-ups being disabled + the wrike-cards function checking the token.)
// If SUPABASE_URL isn't set, auth is considered disabled (e.g. local dev).

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    authEnabled: !!process.env.SUPABASE_URL,
  })
}
