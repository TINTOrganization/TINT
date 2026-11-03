import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_PROXY_TARGET || process.env.VITE_PROXY_API_TARGET || 'http://localhost:8081';
const syncTarget = process.env.SYNC_PROXY_TARGET || 'ws://localhost:8083';
const socialTarget = process.env.SOCIAL_PROXY_TARGET || 'ws://localhost:8082';
const voiceTarget = process.env.VOICE_PROXY_TARGET || 'ws://localhost:8085';
const streamTarget = process.env.STREAM_PROXY_TARGET || 'http://localhost:8086';
const analyticsTarget = process.env.ANALYTICS_PROXY_TARGET || 'http://localhost:8084';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '^/api/v1/rooms/[^/]+/(kpis|reactions/heatmap|timeline)': {
        target: analyticsTarget,
        changeOrigin: true,
      },
      '^/api/v1/stream': {
        target: streamTarget,
        changeOrigin: true,
      },
      '^/api/v1/voice': {
        target: process.env.VOICE_API_TARGET || voiceTarget.replace(/^ws/, 'http'),
        changeOrigin: true,
      },
      '^/api/v1/social': {
        target: process.env.SOCIAL_API_TARGET || socialTarget.replace(/^ws/, 'http'),
        changeOrigin: true,
      },
      '^/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/ws/sync': {
        target: syncTarget,
        ws: true,
        changeOrigin: true,
      },
      '/ws/social': {
        target: socialTarget,
        ws: true,
        changeOrigin: true,
      },
      '/ws/voice': {
        target: voiceTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
