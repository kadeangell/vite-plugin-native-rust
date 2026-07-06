<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<main style="font-family: system-ui, sans-serif; padding: 2rem;">
	<h1>SvelteKit + native Rust</h1>
	<p>
		This page's server <code>load</code> imported a Rust crate straight from
		<code>native/src/lib.rs</code> via <code>vite-plugin-native-rust</code>.
	</p>
	<ul>
		<li>
			<code>add(2, 3) = <span data-testid="sum">{data.sum}</span></code> (sync, main thread)
		</li>
		<li>
			<code>await sumTo(1000) = <span data-testid="total">{data.total}</span></code> (async, off the
			event loop)
		</li>
	</ul>
	<p>Rust calls took <strong>{data.elapsedMs}ms</strong> in this request.</p>
</main>
