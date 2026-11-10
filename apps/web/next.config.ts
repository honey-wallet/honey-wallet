import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    /*
     * 96 has to be declared to be usable. Next 16 only honours a `quality` prop
     * whose value is on this list and silently serves 75 otherwise, which is
     * what it was doing for the mobile hero: the illustration is flat colour
     * with hard edges, and a default-quality encode puts visible ringing along
     * them. 75 stays for everything that does not ask.
     */
    qualities: [75, 96],
  },
};

export default nextConfig;
