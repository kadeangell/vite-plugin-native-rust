// Load the built SSR bundle and print render() output — used by the harness to
// prove the shipped build (not the TS source) produces the expected string.
const mod = await import("./dist/server.js");
process.stdout.write(await mod.render());
