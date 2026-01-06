import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	root: "src/web",
	base: "./",
	build: {
		outDir: "../../public",
		emptyOutDir: true,
	},
	css: {
		preprocessorOptions: {
			scss: {
				// Silence deprecation warnings from Bootstrap's SCSS
				silenceDeprecations: ["import", "global-builtin", "color-functions"],
			},
		},
	},
	server: {
		host: true,
		allowedHosts: true,
		proxy: {
			"/plugins": "http://127.0.0.1:3000",
			"/signalk": "http://127.0.0.1:3000",
		},
	},
});
