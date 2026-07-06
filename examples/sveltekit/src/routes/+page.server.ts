import { add, sumTo } from '$lib/server/rust';
import type { PageServerLoad } from './$types';

// This page calls into a native addon, so it needs a live Node runtime on
// every request. Prerendering is already off by default in SvelteKit, but be
// explicit: a prerendered page would bake the Rust results in at build time.
export const prerender = false;

export const load: PageServerLoad = async () => {
	const start = performance.now();
	// Sync export — runs on the Node main thread; fine because it's trivial.
	const sum = add(2, 3);
	// Async export — runs on napi-rs's Tokio worker pool, off the event loop.
	const total = await sumTo(1000);
	const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
	return { sum, total, elapsedMs };
};
