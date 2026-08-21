/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
