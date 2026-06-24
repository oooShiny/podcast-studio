// Shared nav links for the studio, prep, and settings pages.
(function () {
  var PAGES = [
    { id: "studio", href: "/", label: "Studio" },
    { id: "prep", href: "/prep", label: "Prep" },
    { id: "settings", href: "/settings", label: "Settings", hostOnly: true },
  ];

  function render(el, opts) {
    if (!el) return;
    opts = opts || {};
    var links = PAGES
      .filter(function (p) { return p.id !== opts.current; })
      .filter(function (p) { return !p.hostOnly || opts.role === "host"; })
      .map(function (p) { return '<a href="' + p.href + '">' + p.label + "</a>"; });
    el.innerHTML = links.join('<span class="ps-nav-sep">·</span>');
  }

  window.PSNavHeader = { render: render };
})();
