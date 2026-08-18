/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: the UI is entirely client-side and talks to the FastAPI
  // backend over HTTP, so there is no Node server here. FastAPI serves the
  // built files, which keeps the whole thing one deployable and one origin.
  output: 'export',
  images: { unoptimized: true },
}
export default nextConfig
