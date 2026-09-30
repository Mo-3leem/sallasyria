/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/backend/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'}/:path*`,
      },
    ];
  },
  // Static security headers (roadmap B8, minimal scope): values safe for
  // every frontend route. No CSP here (Next.js hydration inlines +
  // Turnstile + Google Fonts + Font Awesome need their own verification),
  // no HSTS (Cloudflare Pages serves it on *.pages.dev; a custom apex
  // domain is a separate decision), and no global frame-ancestors change
  // (builder/preview framing must stay exactly as-is for now).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;