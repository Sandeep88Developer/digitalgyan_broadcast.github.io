// AuraCast Configuration Popup Controller

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const modeCards = document.querySelectorAll('.mode-card');
  const cameraSelect = document.getElementById('cameraSelect');
  const micSelect = document.getElementById('micSelect');
  const camSelectWrapper = document.getElementById('camSelectWrapper');
  const systemAudioToggle = document.getElementById('systemAudioToggle');
  const typeBubble = document.getElementById('typeBubble');
  const typePip = document.getElementById('typePip');
  const btnStartRecord = document.getElementById('btnStartRecord');
  const btnToggleCamBubble = document.getElementById('btnToggleCamBubble');
  const btnOpenDashboard = document.getElementById('btnOpenDashboard');
  
  const statusIndicator = document.getElementById('statusIndicator');
  const statusLabel = document.getElementById('statusLabel');
  const idleActions = document.getElementById('idleActions');
  const recordingPanel = document.getElementById('recordingPanel');
  const timerDisplay = document.getElementById('timerDisplay');
  
  const btnPause = document.getElementById('btnPause');
  const btnResume = document.getElementById('btnResume');
  const btnStop = document.getElementById('btnStop');

  // State
  let currentMode = 'screencam'; // 'screencam', 'screen', 'camera'
  let currentOverlay = 'bubble'; // 'bubble', 'pip'
  let isWebcamBubbleActive = false;
  let timerInterval = null;

  // Initialize popup
  init();

  function init() {
    // 1. Fetch current recording state from background
    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATE' }, (response) => {
      if (response && response.state) {
        updateUIForState(response.state);
      }
    });

    // Listen for state updates from background
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'STATE_UPDATED') {
        updateUIForState(message.state);
      } else if (message.action === 'BUBBLE_STATUS_UPDATED') {
        isWebcamBubbleActive = message.active;
        updatePreviewBtnUI(isWebcamBubbleActive);
      }
    });

    // 2. Load settings from storage
    chrome.storage.local.get(['recordingConfig', 'webcamBubbleActive'], (res) => {
      if (res.recordingConfig) {
        const config = res.recordingConfig;
        setMode(config.mode);
        setOverlayType(config.overlayType || 'bubble');
        systemAudioToggle.checked = config.recordSystemAudio !== false;
      }
      
      isWebcamBubbleActive = !!res.webcamBubbleActive;
      updatePreviewBtnUI(isWebcamBubbleActive);
      
      // 3. Request permissions & list devices
      requestMediaPermissionsAndLoadDevices();
    });

    // 4. Hook up mode card click handlers
    modeCards.forEach(card => {
      card.addEventListener('click', () => {
        const mode = card.getAttribute('data-mode');
        setMode(mode);
        saveSettings();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const mode = card.getAttribute('data-mode');
          setMode(mode);
          saveSettings();
        }
      });
    });

    // 5. Hook up overlay type selectors
    typeBubble.addEventListener('click', () => {
      setOverlayType('bubble');
      saveSettings();
    });
    typePip.addEventListener('click', () => {
      setOverlayType('pip');
      saveSettings();
    });

    // 6. Device change and toggle handlers
    cameraSelect.addEventListener('change', saveSettings);
    micSelect.addEventListener('change', saveSettings);
    systemAudioToggle.addEventListener('change', saveSettings);

    // 7. Action Button handlers
    btnStartRecord.addEventListener('click', startRecording);
    btnToggleCamBubble.addEventListener('click', toggleCamBubble);
    btnOpenDashboard.addEventListener('click', openDashboard);
    
    // Recording controls handlers
    btnPause.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'PAUSE_RECORDING' });
    });
    btnResume.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'RESUME_RECORDING' });
    });
    btnStop.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'STOP_RECORDING' });
    });
  }

  // Set selected mode UI
  function setMode(mode) {
    currentMode = mode;
    modeCards.forEach(card => {
      if (card.getAttribute('data-mode') === mode) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });

    // Show/hide wrappers based on mode
    if (mode === 'screen') {
      camSelectWrapper.classList.add('disabled');
      cameraSelect.disabled = true;
      document.getElementById('camStyleToggleWrapper').style.opacity = '0.4';
      document.getElementById('camStyleToggleWrapper').style.pointerEvents = 'none';
      btnToggleCamBubble.style.display = 'none';
    } else {
      camSelectWrapper.classList.remove('disabled');
      cameraSelect.disabled = false;
      document.getElementById('camStyleToggleWrapper').style.opacity = '1';
      document.getElementById('camStyleToggleWrapper').style.pointerEvents = 'auto';
      btnToggleCamBubble.style.display = 'block';
    }
  }

  // Set overlay type
  function setOverlayType(type) {
    currentOverlay = type;
    if (type === 'bubble') {
      typeBubble.classList.add('active');
      typePip.classList.remove('active');
      btnToggleCamBubble.innerText = 'Toggle Floating Webcam';
    } else {
      typeBubble.classList.remove('active');
      typePip.classList.add('active');
      btnToggleCamBubble.innerText = 'Toggle Desktop PiP';
    }
  }

  // Load mic and camera devices after requesting permission
  function requestMediaPermissionsAndLoadDevices() {
    navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .then((stream) => {
        // Stop the temp stream immediately
        stream.getTracks().forEach(track => track.stop());
        loadDevices();
      })
      .catch((err) => {
        console.warn('Initial permissions not granted or devices missing:', err);
        // Try listing devices anyway (might show without labels)
        loadDevices();
      });
  }

  function loadDevices() {
    navigator.mediaDevices.enumerateDevices()
      .then((devices) => {
        // Clear options
        cameraSelect.innerHTML = '';
        micSelect.innerHTML = '';

        let camCount = 0;
        let micCount = 0;

        devices.forEach(device => {
          if (device.kind === 'videoinput') {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Camera ${++camCount}`;
            cameraSelect.appendChild(option);
            camCount++;
          } else if (device.kind === 'audioinput') {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Microphone ${++micCount}`;
            micSelect.appendChild(option);
            micCount++;
          }
        });

        // Add a "no camera/mic" option if none found
        if (camCount === 0) {
          const option = document.createElement('option');
          option.value = 'none';
          option.text = 'No camera found';
          cameraSelect.appendChild(option);
        }
        if (micCount === 0) {
          const option = document.createElement('option');
          option.value = 'none';
          option.text = 'No microphone found';
          micSelect.appendChild(option);
        }

        // Restore previously selected devices if saved
        chrome.storage.local.get('recordingConfig', (res) => {
          if (res.recordingConfig) {
            const config = res.recordingConfig;
            if (config.cameraId) cameraSelect.value = config.cameraId;
            if (config.micId) micSelect.value = config.micId;
          }
        });
      })
      .catch((err) => {
        console.error('Error listing devices:', err);
        cameraSelect.innerHTML = '<option value="none">Error loading devices</option>';
        micSelect.innerHTML = '<option value="none">Error loading devices</option>';
      });
  }

  // Save config to storage
  function saveSettings() {
    const config = {
      mode: currentMode,
      cameraId: cameraSelect.value,
      micId: micSelect.value,
      recordSystemAudio: systemAudioToggle.checked,
      overlayType: currentOverlay
    };
    chrome.storage.local.set({ recordingConfig: config });
  }

  // Start recording
  function startRecording() {
    const config = {
      mode: currentMode,
      cameraId: cameraSelect.value,
      micId: micSelect.value,
      recordSystemAudio: systemAudioToggle.checked,
      overlayType: currentOverlay
    };

    // Save configuration before running
    chrome.storage.local.set({ recordingConfig: config }, () => {
      chrome.runtime.sendMessage({
        action: 'START_RECORDING',
        options: config
      }, (response) => {
        if (response && response.success) {
          // Keep popup open, background state handler will switch popup UI
          console.log('Recording start process initialized');
        } else {
          alert('Failed to start recording: ' + (response?.error || 'Unknown error'));
        }
      });
    });
  }

  // Toggle Camera overlay bubble inside active tab
  function toggleCamBubble() {
    // Tell background script to toggle camera bubble in active tab
    chrome.runtime.sendMessage({ action: 'TOGGLE_CAMERA_BUBBLE' }, (response) => {
      if (response && response.success) {
        isWebcamBubbleActive = response.active;
        chrome.storage.local.set({ webcamBubbleActive: isWebcamBubbleActive });
        updatePreviewBtnUI(isWebcamBubbleActive);
      } else {
        alert(response?.error || 'Cannot show floating webcam overlay on this tab.');
      }
    });
  }

  function updatePreviewBtnUI(active) {
    if (active) {
      btnToggleCamBubble.classList.add('btn-secondary');
      btnToggleCamBubble.classList.remove('btn-primary');
      if (currentOverlay === 'bubble') {
        btnToggleCamBubble.innerText = 'Hide Floating Webcam';
      } else {
        btnToggleCamBubble.innerText = 'Hide Desktop PiP';
      }
    } else {
      btnToggleCamBubble.classList.remove('btn-secondary');
      btnToggleCamBubble.classList.add('btn-primary');
      if (currentOverlay === 'bubble') {
        btnToggleCamBubble.innerText = 'Toggle Floating Webcam';
      } else {
        btnToggleCamBubble.innerText = 'Toggle Desktop PiP';
      }
    }
  }

  // Open the recordings dashboard
  function openDashboard() {
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.create({ url: dashboardUrl });
  }

  // Handle popup UI transitions based on recording status
  function updateUIForState(state) {
    if (state.status === 'idle') {
      // Show config, hide timer panel
      idleActions.classList.remove('hidden');
      document.querySelector('.settings-section').classList.remove('hidden');
      document.querySelector('.section').classList.remove('hidden');
      recordingPanel.classList.add('hidden');
      
      statusIndicator.className = 'status-indicator idle';
      statusLabel.innerText = 'Ready';
      
      stopTimer();
    } else {
      // Hide config, show timer panel
      idleActions.classList.add('hidden');
      document.querySelector('.settings-section').classList.add('hidden');
      document.querySelector('.section').classList.add('hidden');
      recordingPanel.classList.remove('hidden');
      
      statusIndicator.className = 'status-indicator recording';
      statusLabel.innerText = state.status === 'recording' ? 'Recording' : 'Paused';

      // Toggle Pause/Resume button view
      if (state.status === 'paused') {
        btnPause.classList.add('hidden');
        btnResume.classList.remove('hidden');
      } else {
        btnPause.classList.remove('hidden');
        btnResume.classList.add('hidden');
      }

      startTimer(state.startTime, state.status === 'paused');
    }
  }

  function startTimer(startTime, isPaused) {
    stopTimer();
    if (!startTime) return;

    const updateTime = () => {
      let elapsedMs = Date.now() - startTime;
      if (isPaused) {
        // Adjust for pauses by holding at state check time
        // The background script will manage correct cumulative duration,
        // but for a simple popup clock we can fetch details from storage:
        chrome.storage.local.get('recordingState', (res) => {
          if (res.recordingState && res.recordingState.accumulatedTime) {
            timerDisplay.innerText = formatDuration(res.recordingState.accumulatedTime);
          }
        });
        return;
      }
      
      // Calculate elapsed from start time
      // If we paused previously, the background will give us the base offset
      chrome.storage.local.get('recordingState', (res) => {
        if (res.recordingState) {
          let totalElapsed = elapsedMs;
          if (res.recordingState.baseDuration) {
            totalElapsed = res.recordingState.baseDuration + (res.recordingState.status === 'recording' ? (Date.now() - res.recordingState.lastResumeTime) : 0);
          }
          timerDisplay.innerText = formatDuration(totalElapsed);
        }
      });
    };

    updateTime();
    if (!isPaused) {
      timerInterval = setInterval(updateTime, 1000);
    }
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerDisplay.innerText = '00:00';
  }

  function formatDuration(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;

    const pad = (num) => String(num).padStart(2, '0');
    
    if (hours > 0) {
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
  }
});
