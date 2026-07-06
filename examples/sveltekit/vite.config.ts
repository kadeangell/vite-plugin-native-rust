import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { rustPlugin } from 'vite-plugin-native-rust';

export default defineConfig({
	plugins: [
		// rustPlugin() before the framework plugin so it claims `.rs` specifiers
		// first (it also sets enforce: "pre").
		rustPlugin(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Pin the function runtime: adapter-vercel only auto-detects when the
			// local Node is 20/22/24, and napi-rs is happy on Node 24.
			adapter: adapter({ runtime: 'nodejs24.x' })
		})
	]
});
