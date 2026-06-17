// AuraCast Webpage Content Script
(function () {
  // Prevent duplicate declaration if already injected
  if (window.auracastInjected) {
    // Just report back that we are ready
    return;
  }
  window.auracastInjected = true;

  console.log('AuraCast Content Script Active');

  // Globals
  let widgetRoot = null;
  let camBubble = null;
  let controlBar = null;
  let timerEl = null;
  let btnPause = null;
  let btnResume = null;
  let btnMic = null;
  let btnCam = null;
  
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let widgetStartX = 0;
  let widgetStartY = 0;
  
  let recordingState = { status: 'idle', startTime: null };
  let bubbleSize = 'medium'; // 'small', 'medium', 'large'
  let micMuted = false;
  let camHidden = false;
  let timerInterval = null;

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'PING':
        sendResponse({ pong: true });
        break;

      case 'TOGGLE_CAMERA':
        const active = toggleWidget();
        sendResponse({ active: active });
        break;

      case 'STATE_UPDATED':
        recordingState = message.state;
        updateUIForState(recordingState);
        sendResponse({ success: true });
        break;

      case 'CLOSE_CAMERA_BUBBLE':
        removeWidget();
        sendResponse({ success: true });
        break;

      case 'UPDATE_BUBBLE_SETTINGS':
        if (message.config) {
          syncConfig(message.config);
        }
        sendResponse({ success: true });
        break;
    }
  });

  // Load initial state on injection
  chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATE' }, (response) => {
    if (response && response.state) {
      recordingState = response.state;
      // If we are actively recording, we should show the widget automatically
      if (recordingState.status !== 'idle') {
        createWidget();
        updateUIForState(recordingState);
      }
    }
  });

  function createWidget() {
    if (widgetRoot) return;

    // Create Root Container
    widgetRoot = document.createElement('div');
    widgetRoot.id = 'auracast-widget-root';
    widgetRoot.className = `auracast-size-${bubbleSize}`;
    
    // Default positioning: Bottom Left
    widgetRoot.style.left = '30px';
    widgetRoot.style.bottom = '30px';

    // Create Camera Bubble
    camBubble = document.createElement('div');
    camBubble.id = 'auracast-cam-bubble';
    
    // Create Iframe for Extension camera page
    const iframe = document.createElement('iframe');
    iframe.setAttribute('allow', 'camera; microphone');
    iframe.src = chrome.runtime.getURL('camera.html');
    iframe.id = 'auracast-cam-iframe';
    
    camBubble.appendChild(iframe);

    // Create transparent drag overlay to prevent iframe from blocking dragging events
    const dragOverlay = document.createElement('div');
    dragOverlay.className = 'auracast-drag-overlay';
    camBubble.appendChild(dragOverlay);

    // Create Control Bar
    controlBar = document.createElement('div');
    controlBar.id = 'auracast-control-bar';

    // Timer display
    timerEl = document.createElement('div');
    timerEl.className = 'auracast-control-timer';
    timerEl.innerText = '00:00';
    controlBar.appendChild(timerEl);

    // Pause/Resume Button
    btnPause = createControlButton('pause', `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <rect x="6" y="4" width="4" height="16" />
        <rect x="14" y="4" width="4" height="16" />
      </svg>
    `, 'Pause Recording');
    btnPause.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'PAUSE_RECORDING' });
    });
    controlBar.appendChild(btnPause);

    btnResume = createControlButton('resume', `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5,3 19,12 5,21" />
      </svg>
    `, 'Resume Recording');
    btnResume.classList.add('auracast-hidden');
    btnResume.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'RESUME_RECORDING' });
    });
    controlBar.appendChild(btnResume);

    // Stop Button
    const btnStop = createControlButton('stop', `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <rect x="4" y="4" width="16" height="16" rx="2" />
      </svg>
    `, 'Stop & Save');
    btnStop.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'STOP_RECORDING' });
    });
    controlBar.appendChild(btnStop);

    // Mic Toggle Button
    btnMic = createControlButton('mic', `
      <svg class="mic-on" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8" />
      </svg>
      <svg class="mic-off auracast-hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="1" y1="1" x2="23" y2="23"></line>
        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
        <path d="M17 11a7 7 0 0 1-12 0M12 19v4M8 23h8"></path>
      </svg>
    `, 'Mute Microphone');
    btnMic.addEventListener('click', toggleMic);
    controlBar.appendChild(btnMic);

    // Camera Toggle Button
    btnCam = createControlButton('cam', `
      <svg class="cam-on" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 7l-7 5 7 5V7z" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      <svg class="cam-off auracast-hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10l-2.66-1.9"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
    `, 'Hide Camera');
    btnCam.addEventListener('click', toggleCamVisibility);
    controlBar.appendChild(btnCam);

    // Size Switcher Button (only relevant when cam is visible)
    const btnSize = createControlButton('size', `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
      </svg>
    `, 'Change Bubble Size');
    btnSize.addEventListener('click', cycleSize);
    controlBar.appendChild(btnSize);

    // Assembly
    widgetRoot.appendChild(camBubble);
    widgetRoot.appendChild(controlBar);
    document.body.appendChild(widgetRoot);

    // Drag and Drop Initialization
    setupDragging();

    // Trigger local state check
    chrome.storage.local.get('recordingConfig', (res) => {
      if (res.recordingConfig) {
        syncConfig(res.recordingConfig);
      }
    });
  }

  function createControlButton(name, svgHtml, tooltip) {
    const btn = document.createElement('button');
    btn.className = `auracast-control-btn auracast-btn-${name}`;
    btn.innerHTML = svgHtml;
    btn.title = tooltip;
    return btn;
  }

  function toggleWidget() {
    if (widgetRoot) {
      // If we are actively recording, don't remove, just toggle camera bubble visibility
      if (recordingState.status !== 'idle') {
        toggleCamVisibility();
        return !camHidden;
      } else {
        removeWidget();
        chrome.runtime.sendMessage({ action: 'BUBBLE_STATUS_UPDATED', active: false });
        return false;
      }
    } else {
      createWidget();
      chrome.runtime.sendMessage({ action: 'BUBBLE_STATUS_UPDATED', active: true });
      return true;
    }
  }

  function removeWidget() {
    stopWidgetTimer();
    if (widgetRoot) {
      widgetRoot.remove();
      widgetRoot = null;
      camBubble = null;
      controlBar = null;
    }
  }

  // Handle Drag & Drop
  function setupDragging() {
    // Drag can be initiated on the camera bubble or the timer
    const dragTargets = [camBubble, timerEl];

    dragTargets.forEach(target => {
      if (!target) return;
      
      target.addEventListener('mousedown', dragStart);
      
      // Touch support
      target.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          dragStart(e.touches[0]);
        }
      });
    });

    window.addEventListener('mousemove', drag);
    window.addEventListener('mouseup', dragEnd);
    
    window.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        drag(e.touches[0]);
      }
    });
    window.addEventListener('touchend', dragEnd);
  }

  function dragStart(e) {
    // Don't drag if clicking buttons
    if (e.target.closest('button')) return;
    
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    
    const rect = widgetRoot.getBoundingClientRect();
    widgetStartX = rect.left;
    widgetStartY = rect.top;

    // Apply active dragging class for styling (e.g. pointer-events none on iframe)
    widgetRoot.classList.add('auracast-dragging');
  }

  function drag(e) {
    if (!isDragging) return;
    e.preventDefault ? e.preventDefault() : null;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    let targetX = widgetStartX + deltaX;
    let targetY = widgetStartY + deltaY;

    // Boundary constraints (stay within screen)
    const padding = 15;
    const rect = widgetRoot.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - padding;
    const maxY = window.innerHeight - rect.height - padding;

    targetX = Math.max(padding, Math.min(targetX, maxX));
    targetY = Math.max(padding, Math.min(targetY, maxY));

    // Position using fixed values
    widgetRoot.style.left = `${targetX}px`;
    widgetRoot.style.top = `${targetY}px`;
    widgetRoot.style.bottom = 'auto'; // Clear bottom since we are moving top
  }

  function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    widgetRoot.classList.remove('auracast-dragging');
  }

  // Cycle Camera sizes
  function cycleSize() {
    widgetRoot.classList.remove(`auracast-size-${bubbleSize}`);
    if (bubbleSize === 'small') {
      bubbleSize = 'medium';
    } else if (bubbleSize === 'medium') {
      bubbleSize = 'large';
    } else {
      bubbleSize = 'small';
    }
    bubbleSize = bubbleSize;
    widgetRoot.classList.add(`auracast-size-${bubbleSize}`);
    
    // Ensure it stays in bounds after resize
    setTimeout(() => {
      const padding = 15;
      const rect = widgetRoot.getBoundingClientRect();
      let x = rect.left;
      let y = rect.top;
      const maxX = window.innerWidth - rect.width - padding;
      const maxY = window.innerHeight - rect.height - padding;
      
      x = Math.max(padding, Math.min(x, maxX));
      y = Math.max(padding, Math.min(y, maxY));
      
      widgetRoot.style.left = `${x}px`;
      widgetRoot.style.top = `${y}px`;
    }, 100);
  }

  // Toggle Camera visibility within widget
  function toggleCamVisibility() {
    camHidden = !camHidden;
    if (camHidden) {
      camBubble.classList.add('auracast-collapsed');
      btnCam.querySelector('.cam-on').classList.add('auracast-hidden');
      btnCam.querySelector('.cam-off').classList.remove('auracast-hidden');
      btnCam.title = 'Show Camera';
      widgetRoot.classList.add('auracast-cam-hidden');
    } else {
      camBubble.classList.remove('auracast-collapsed');
      btnCam.querySelector('.cam-on').classList.remove('auracast-hidden');
      btnCam.querySelector('.cam-off').classList.add('auracast-hidden');
      btnCam.title = 'Hide Camera';
      widgetRoot.classList.remove('auracast-cam-hidden');
    }
  }

  // Mute microphone
  function toggleMic() {
    micMuted = !micMuted;
    if (micMuted) {
      btnMic.querySelector('.mic-on').classList.add('auracast-hidden');
      btnMic.querySelector('.mic-off').classList.remove('auracast-hidden');
      btnMic.title = 'Unmute Microphone';
      btnMic.classList.add('auracast-btn-active');
    } else {
      btnMic.querySelector('.mic-on').classList.remove('auracast-hidden');
      btnMic.querySelector('.mic-off').classList.add('auracast-hidden');
      btnMic.title = 'Mute Microphone';
      btnMic.classList.remove('auracast-btn-active');
    }

    // Inform dashboard to mute mic track
    chrome.runtime.sendMessage({
      action: 'CONTROL_RECORDING',
      command: 'TOGGLE_MIC',
      muted: micMuted
    });
  }

  // Sync settings configuration
  function syncConfig(config) {
    if (config.mode === 'screen') {
      if (camBubble) {
        camBubble.classList.add('auracast-collapsed');
        widgetRoot.classList.add('auracast-cam-hidden');
      }
      if (btnCam) btnCam.style.display = 'none';
      if (widgetRoot) {
        // Find Size button and hide it
        const btnSize = widgetRoot.querySelector('.auracast-btn-size');
        if (btnSize) btnSize.style.display = 'none';
      }
    } else {
      if (camBubble && !camHidden) {
        camBubble.classList.remove('auracast-collapsed');
        widgetRoot.classList.remove('auracast-cam-hidden');
      }
      if (btnCam) btnCam.style.display = 'block';
      if (widgetRoot) {
        const btnSize = widgetRoot.querySelector('.auracast-btn-size');
        if (btnSize) btnSize.style.display = 'block';
      }
    }
    
    // Check overlay type
    if (config.overlayType === 'pip') {
      // Desktop PiP hides the inside-page bubble entirely
      if (widgetRoot) widgetRoot.classList.add('auracast-pip-active');
    } else {
      if (widgetRoot) widgetRoot.classList.remove('auracast-pip-active');
    }
  }

  // Monitor recording states to transition the controls
  function updateUIForState(state) {
    // Make sure widget is created
    if (state.status !== 'idle' && !widgetRoot) {
      createWidget();
    }

    if (!widgetRoot) return;

    if (state.status === 'idle') {
      removeWidget();
    } else {
      // Recording or paused
      widgetRoot.classList.add('auracast-recording-active');
      
      if (state.status === 'paused') {
        btnPause.classList.add('auracast-hidden');
        btnResume.classList.remove('auracast-hidden');
        widgetRoot.classList.add('auracast-recording-paused');
      } else {
        btnPause.classList.remove('auracast-hidden');
        btnResume.classList.add('auracast-hidden');
        widgetRoot.classList.remove('auracast-recording-paused');
      }

      startWidgetTimer(state.startTime, state.status === 'paused');
    }
  }

  // Inside-widget timer clock
  function startWidgetTimer(startTime, isPaused) {
    stopWidgetTimer();
    if (!startTime) return;

    const updateClock = () => {
      chrome.storage.local.get('recordingState', (res) => {
        if (res.recordingState && timerEl) {
          let totalElapsed = Date.now() - startTime;
          if (res.recordingState.baseDuration) {
            totalElapsed = res.recordingState.baseDuration + (res.recordingState.status === 'recording' ? (Date.now() - res.recordingState.lastResumeTime) : 0);
          }
          timerEl.innerText = formatTime(totalElapsed);
        }
      });
    };

    updateClock();
    if (!isPaused) {
      timerInterval = setInterval(updateClock, 1000);
    }
  }

  function stopWidgetTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (timerEl) timerEl.innerText = '00:00';
  }

  function formatTime(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

})();
