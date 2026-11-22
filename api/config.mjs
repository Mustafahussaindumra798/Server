export default function handler(_request, response) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify({
    supabaseUrl,
    supabasePublishableKey: publishableKey,
    authConfigured: Boolean(supabaseUrl && publishableKey)
  }));
}
