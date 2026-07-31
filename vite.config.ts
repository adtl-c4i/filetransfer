import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["**/*.{html,css,js,wasm,svg,png}"],
      manifest: {
        name: "Decimen Optical Transfer",
        short_name: "Decimen",
        description: "Offline screen-to-camera optical file transfer",
        theme_color: "#121009",
        background_color: "#121009",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f4f6.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f4f6.png",
            sizes: "512x512",
            type: "image/png"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm,png,svg}"]
      }
    })
  ]
});
