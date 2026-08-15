import { fileURLToPath, URL } from "node:url";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function sitesOutput(): Plugin {
  return {
    name: "robotube-sites-output",
    apply: "build",
    async buildStart() {
      const projectRoot = fileURLToPath(new URL(".", import.meta.url));
      await rm(resolve(projectRoot, "dist"), { recursive: true, force: true });
    },
    async closeBundle() {
      const projectRoot = fileURLToPath(new URL(".", import.meta.url));
      const distRoot = resolve(projectRoot, "dist");
      const serverRoot = resolve(distRoot, "server");
      const metadataRoot = resolve(distRoot, ".openai");

      await mkdir(serverRoot, { recursive: true });
      await mkdir(metadataRoot, { recursive: true });
      await cp(
        resolve(projectRoot, ".openai", "hosting.json"),
        resolve(metadataRoot, "hosting.json"),
      );

      const workerSource = `const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;
    const fallback = new URL("/index.html", request.url);
    return env.ASSETS.fetch(new Request(fallback, request));
  },
};
export default worker;
`;
      await writeFile(resolve(serverRoot, "index.js"), workerSource, "utf8");

      // Assert the generated SPA entry is present before a publish can be packaged.
      await readFile(resolve(distRoot, "client", "index.html"), "utf8");
    },
  };
}

export default defineConfig({
  plugins: [react(), sitesOutput()],
  envDir: "..",
  envPrefix: ["VITE_", "EXPO_PUBLIC_"],
  publicDir: "public",
  server: {
    port: 5173,
  },
  build: {
    target: "es2022",
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
