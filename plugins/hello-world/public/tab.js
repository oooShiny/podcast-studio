// Registers a "Plugin Demo" sidebar tab purely via the plugin registration
// API in index.html — confirms Phase 3's frontend extension point works
// end-to-end with zero edits to index.html itself.
window.PodcastStudioPlugins.registerSidebarTab({
  id: "hello-world",
  label: "Plugin Demo",
  panelHTML: `
    <div class="panel-section">
      <p id="hello-world-status">Loading…</p>
    </div>
  `,
  onMount(panel) {
    fetch("/api/plugins/hello-world")
      .then((res) => res.json())
      .then((data) => {
        panel.querySelector("#hello-world-status").textContent = data.message;
      })
      .catch(() => {
        panel.querySelector("#hello-world-status").textContent = "Failed to reach hello-world plugin.";
      });
  },
});
