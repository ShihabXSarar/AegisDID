/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next build` and `next dev` share this directory, so a verification build run while the
  // dev server is up deletes the dev server's compiled CSS/JS and every page starts serving
  // unstyled HTML (the dev server keeps referencing /_next/static/css/app/layout.css, which
  // the production build replaces with a content-hashed filename -> 404). Use `npm run
  // build:verify` to build into .next-verify instead and leave a running dev server intact.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Disable image optimization so logo loads correctly through tunnel/mobile
  images: {
    unoptimized: true,
  },
  // Allow all localtunnel / ngrok / external tunnel origins so CSS/JS loads on mobile
  allowedDevOrigins: [
    "*.loca.lt",
    "*.ngrok.io",
    "*.ngrok-free.app",
    "localhost",
    "192.168.0.105",
  ],
  // CRITICAL: Mark native-addon / WASM packages as external so Next.js server-side
  // doesn't try to webpack-bundle them (which causes "Cannot find module './331.js'" crashes).
  serverExternalPackages: [
    'circomlibjs',
    'ffjavascript',
    'snarkjs',
  ],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        readline: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        encoding: false,
      };
    }
    return config;
  },
};

export default nextConfig;
