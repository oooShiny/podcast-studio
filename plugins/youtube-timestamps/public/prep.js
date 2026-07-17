(function () {
  'use strict';

  // ── YouTube IFrame API bootstrap ────────────────────────────────────
  // The API script sets window.YT and then calls onYouTubeIframeAPIReady.
  // We queue callbacks so multiple mount() calls before the API loads still work.
  var ytReady = false;
  var ytQueue = [];

  function whenYTReady(cb) {
    if (ytReady) { cb(); return; }
    ytQueue.push(cb);
  }

  var prevReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function () {
    if (prevReady) prevReady();
    ytReady = true;
    ytQueue.forEach(function (cb) { cb(); });
    ytQueue = [];
  };

  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);

  // ── Register viewer ─────────────────────────────────────────────────
  window.PodcastStudioPrep.registerSourceViewer({
    match: function (src) {
      return !!(src.type === 'url' && src.embedUrl && src.embedUrl.indexOf('youtube') !== -1);
    },

    mount: function (container, src) {
      // Extract video ID and optional start time from the embed URL
      // embedUrl shape: https://www.youtube-nocookie.com/embed/VIDEO_ID[?start=N]
      var idMatch = src.embedUrl.match(/\/embed\/([^?#/]+)/);
      if (!idMatch) return null;
      var videoId = idMatch[1];
      var startMatch = src.embedUrl.match(/[?&]start=(\d+)/);
      var startSeconds = startMatch ? parseInt(startMatch[1], 10) : 0;

      // Build container HTML: a div for the IFrame API to inject into + controls
      container.innerHTML =
        '<div id="yt-player-root" style="width:100%;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:#000;flex-shrink:0"></div>' +
        '<div style="display:flex;align-items:center;gap:10px;padding:4px 0">' +
          '<button id="yt-ts-btn" style="' +
            'background:transparent;border:1px solid var(--border,#2a2a38);color:var(--text,#e8e6f0);' +
            'border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit' +
          '">⏱ Insert timestamp</button>' +
          '<span style="font-size:11px;color:var(--text-dim,#8a879a)">Screenshots not available for YouTube (browser security)</span>' +
        '</div>';

      var player = null;
      var tsBtn = container.querySelector('#yt-ts-btn');

      tsBtn.addEventListener('click', function () {
        window.PodcastStudioPrep.insertTimestamp();
      });

      whenYTReady(function () {
        // The div we're targeting may have been removed if the user switched away
        // before the API finished loading — guard against that.
        var root = container.querySelector('#yt-player-root');
        if (!root) return;

        player = new YT.Player(root, {
          videoId: videoId,
          playerVars: {
            start: startSeconds,
            rel: 0,
            modestbranding: 1,
          },
        });
      });

      return {
        getTime: function () {
          if (!player || typeof player.getCurrentTime !== 'function') return 0;
          return player.getCurrentTime() || 0;
        },
        seekTo: function (secs) {
          if (!player || typeof player.seekTo !== 'function') return;
          player.seekTo(secs, true);
          player.playVideo();
        },
        cleanup: function () {
          try { if (player) player.destroy(); } catch (e) {}
          player = null;
        },
      };
    },
  });
})();
