import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  agentRules: false,
  output: "standalone",
  poweredByHeader: false,
  // The floating dev badge covers bottom-left controls on the phone layouts.
  devIndicators: false,
  // Dev mode only trusts localhost; let phones on the same Wi-Fi/hotspot load /_next chunks.
  // Patterns match right-to-left per dot segment, so IPv4 needs all four parts.
  allowedDevOrigins: ["10.*.*.*", "172.*.*.*", "192.168.*.*", "*.local"],
  webpack(config, { webpack }) {
    config.resolve.alias = {
      "@/lib/cms-store$": resolve(process.cwd(), "lib/cms-store-node.ts"),
      "@/lib/admin-config$": resolve(process.cwd(), "lib/admin-config-node.ts"),
      ...config.resolve.alias,
    };
    // Next's tsconfig resolver can expand @/ paths before the alias resolver.
    // Replace the two server modules at the request boundary as well.
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /(?:^@\/lib\/|[\\/]lib[\\/])(cms-store|admin-config)(?:\.ts)?$/,
      (resource: { request: string }) => {
        const module = resource.request.includes("admin-config") ? "admin-config-node" : "cms-store-node";
        resource.request = resolve(process.cwd(), `lib/${module}.ts`);
      },
    ));
    return config;
  },
};

export default nextConfig;
