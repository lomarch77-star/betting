import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Dev-server proxies give the browser a same-origin path to the exchange APIs.
 * This sidesteps CORS entirely and keeps the app working behind restrictive
 * networks. The client tries the proxy first, then the public origin, then
 * falls back to the built-in offline simulator.
 */
const EXCHANGE_PROXIES: Record<string, string> = {
  '/api/binance': 'https://api.binance.com',
  '/api/coinbase': 'https://api.coinbase.com',
  '/api/cb-exchange': 'https://api.exchange.coinbase.com',
  '/api/kraken': 'https://api.kraken.com',
  '/api/coingecko': 'https://api.coingecko.com',
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PaperDesk — Local Trading Agent',
        short_name: 'PaperDesk',
        description:
          'A local-first, offline-capable crypto paper-trading agent that runs entirely on your phone.',
        theme_color: '#0b1020',
        background_color: '#0b1020',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        id: '/',
        categories: ['finance', 'productivity'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Never let the service worker swallow exchange API traffic — the app
        // must always see fresh quotes when it is online.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/(api|api1|api2|api3|api4)\.binance\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'quotes',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/api\.(exchange\.)?coinbase\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'quotes',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/api\.(kraken|coingecko)\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'quotes',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: Object.fromEntries(
      Object.entries(EXCHANGE_PROXIES).map(([path, target]) => [
        path,
        { target, changeOrigin: true, rewrite: (p: string) => p.replace(path, '') },
      ]),
    ),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
