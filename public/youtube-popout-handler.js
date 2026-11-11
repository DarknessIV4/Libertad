// Handler for YouTube iframe pop-out/pop-in
// This runs in the popup window and moves the iframe back to the opener on close

(function() {
  var iframe = null;
  var closed = false;
  var mainWindow = window.opener;
  var ready = false;

  function moveBack() {
    if (closed || !iframe || !mainWindow) return;
    closed = true;

    // Remove iframe from this popup's document
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }

    // Move back to main window's body temporarily
    // The main window's popInYouTube will find it and move to the correct spot
    try {
      mainWindow.document.body.appendChild(iframe);
    } catch (e) {
      console.error('[Popup] Failed to move iframe back:', e);
    }

    // Signal main window to restore
    try {
      mainWindow.postMessage({ type: 'mumh5-youtube-popin' }, '*');
    } catch (e) {
      console.error('[Popup] Failed to post popin message:', e);
    }
  }

  function checkForExistingIframe() {
    var iframes = document.querySelectorAll('.youtube-iframe');
    if (iframes.length > 0) {
      iframe = iframes[0];
      console.log('[Popup] Found existing YouTube iframe on load');
      return true;
    }
    return false;
  }

  // Check for iframe immediately (in case it was added before script ran)
  checkForExistingIframe();

  // Use MutationObserver to find the iframe when it's added later
  var observer = new MutationObserver(function(mutations) {
    if (iframe) return; // Already found
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (node.tagName === 'IFRAME' && node.classList.contains('youtube-iframe')) {
          iframe = node;
          console.log('[Popup] YouTube iframe detected via MutationObserver');
          break;
        }
      }
      if (iframe) break;
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Signal main window that popup is ready to receive iframe
  function signalReady() {
    if (ready) return;
    ready = true;
    if (mainWindow && !mainWindow.closed) {
      try {
        mainWindow.postMessage({ type: 'mumh5-popup-ready' }, '*');
        console.log('[Popup] Signaled ready to main window');
      } catch (e) {
        console.error('[Popup] Failed to signal ready:', e);
      }
    }
  }

  // Signal ready when script loads
  signalReady();

  // Listen for beforeunload to move iframe back before window closes
  window.addEventListener('beforeunload', moveBack);
  window.addEventListener('pagehide', moveBack);

  // Also listen for explicit close message from main window
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'mumh5-close-youtube-popout') {
      console.log('[Popup] Received close signal from main window');
      moveBack();
      window.close();
    }
  });
})();