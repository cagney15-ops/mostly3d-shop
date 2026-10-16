// Supabase project for the Mostly 3D shop. The anon key is public by design; row-level security
// in the database decides who can read or write (only emails on the allowed_users list).
export const CONFIG = {
  supabaseUrl: 'https://mkwthdcpafpmxwpdgbov.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rd3RoZGNwYWZwbXh3cGRnYm92Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwOTUxNjksImV4cCI6MjA5NTY3MTE2OX0.6kpxm2Fapj-jCUxU1nbSBUkddE4luCMONNfdBzkMfdU',
  photoBucket: 'product-photos'
};
