// AuraCast Recorder & Library Dashboard Controller

// Database Configuration
const DB_NAME = 'AuraCastDB';
const STORE_NAME = 'recordings';
let db = null;

// Recording state variables
let mediaRecorder = null;
let recordedChunks = [];
let screenStream = null;
let micStream = null;
let audioContext = null;
let audioDestination = null;
let recordingStartTime = null;
let pipWindow = null;
let pipCamStream = null;

// Cumulative timing tracker for pauses
let baseDuration = 0;
let lastResumeTime = null;

document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const videoGrid = document.getElementById('videoGrid');
  const emptyState = document.getElementById('emptyState');
  const videosCountLabel = document.getElementById('videosCountLabel');
  
  // Modals
  const capturePromptOverlay = document.getElementById('capturePromptOverlay');
  const playerModalOverlay = document.getElementById('playerModalOverlay');
  
  // Modal Buttons
  const btnTriggerCapturePrompt = document.getElementById('btnTriggerCapturePrompt');
  const btnCancelCapture = document.getElementById('btnCancelCapture');
  const btnClosePlayer = document.getElementById('btnClosePlayer');
  
  // Actions
  const btnRefreshList = document.getElementById('btnRefreshList');
  const btnCreateNewRecord = document.getElementById('btnCreateNewRecord');
  const btnEmptyStart = document.getElementById('btnEmptyStart');
  
  // Player Modal inner components
  const playerElement = document.getElementById('playerElement');
  const playerVideoTitle = document.getElementById('playerVideoTitle');
  const btnSaveTitle = document.getElementById('btnSaveTitle');
  const btnPlayerDelete = document.getElementById('btnPlayerDelete');
  const btnPlayerDownload = document.getElementById('btnPlayerDownload');
  const playerStatDate = document.getElementById('playerStatDate');
  const playerStatSize = document.getElementById('playerStatSize');
  
  // Storage indicators
  const storageText = document.getElementById('storageText');
  const storageBarFill = document.getElementById('storageBarFill');

  // PiP Launcher UI
  const pipLauncherSection = document.getElementById('pipLauncherSection');
  const btnLaunchPip = document.getElementById('btnLaunchPip');
  const pipStatus = document.getElementById('pipStatus');
  const pipStatusText = document.getElementById('pipStatusText');

  // Currently active video in player modal
  let currentPlayerVideoId = null;
  let pipAlreadyLaunched = false;
  let cachedConfig = {};
  
  // Local widget variables for dashboard overlay
  let localWidgetRoot = null;
  let localCamBubble = null;
  let localControlBar = null;
  let localTimerEl = null;
  let localTimerInterval = null;

  // Initialize DB and load videos
  initDB().then(() => {
    loadRecordings();
    updateStorageUsage();
  });

  // Check if we should automatically launch recorder (opened from popup)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('start') === 'true') {
    // Clear URL query parameters for clean look
    window.history.replaceState({}, document.title, window.location.pathname);
    showCapturePrompt();
  }

  // Hook Up Event Listeners
  btnRefreshList.addEventListener('click', loadRecordings);
  btnCreateNewRecord.addEventListener('click', showCapturePrompt);
  btnEmptyStart.addEventListener('click', showCapturePrompt);
  
  btnTriggerCapturePrompt.addEventListener('click', async () => {
    // If they haven't launched PiP yet and config is screencam + pip, try to launch it automatically
    if (cachedConfig.mode === 'screencam' && cachedConfig.overlayType === 'pip' && !pipAlreadyLaunched) {
      try {
        await openPipWindow(cachedConfig);
        pipAlreadyLaunched = true;
      } catch (err) {
        console.error('Auto-launching PiP webcam failed:', err);
      }
    }
    startRecordingFlow();
  });
  btnCancelCapture.addEventListener('click', () => {
    hideCapturePrompt();
    pipAlreadyLaunched = false;
  });

  // PiP Launch button — called directly from user click, satisfying Chrome's gesture requirement
  btnLaunchPip.addEventListener('click', async () => {
    if (pipAlreadyLaunched) return;
    btnLaunchPip.disabled = true;
    btnLaunchPip.querySelector('span').textContent = 'Starting webcam...';
    const data = await chrome.storage.local.get('recordingConfig');
    const config = data.recordingConfig || {};
    try {
      await openPipWindow(config);
      if (document.pictureInPictureElement) {
        pipAlreadyLaunched = true;
        pipStatus.classList.add('active');
        pipStatusText.textContent = 'Webcam PiP is live ✓';
        btnLaunchPip.querySelector('span').textContent = 'Webcam Running';
      } else {
        btnLaunchPip.disabled = false;
        btnLaunchPip.querySelector('span').textContent = 'Launch Floating Webcam';
        pipStatusText.textContent = 'Failed — try again';
      }
    } catch (err) {
      btnLaunchPip.disabled = false;
      btnLaunchPip.querySelector('span').textContent = 'Launch Floating Webcam';
      
      let errorMsg = 'Failed — try again';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMsg = 'Permission denied';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMsg = 'Camera not found';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        errorMsg = 'Camera busy / in use';
      } else if (err.name === 'OverconstrainedError') {
        errorMsg = 'Constraints failed';
      }
      
      pipStatusText.textContent = errorMsg;
      console.error('Error during PiP launch:', err);
    }
  });

  btnClosePlayer.addEventListener('click', closePlayerModal);
  btnSaveTitle.addEventListener('click', savePlayerVideoTitle);

  // Background Messages listener for recording controls
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Dashboard received message:', message);
    
    switch (message.action) {
      case 'TRIGGER_CAPTURE':
        showCapturePrompt();
        sendResponse({ success: true });
        break;
      
      case 'PAUSE_RECORDING':
        pauseRecording();
        sendResponse({ success: true });
        break;

      case 'RESUME_RECORDING':
        resumeRecording();
        sendResponse({ success: true });
        break;

      case 'STOP_RECORDING':
        stopRecordingFlow();
        sendResponse({ success: true });
        break;
      
      case 'CONTROL_RECORDING':
        if (message.command === 'TOGGLE_MIC') {
          toggleMicMute(message.muted);
        }
        sendResponse({ success: true });
        break;
    }
  });

  // DB initialization
  function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      
      request.onerror = (e) => reject(e.target.error);
      
      request.onsuccess = (e) => {
        db = e.target.result;
        resolve();
      };
      
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  }

  // Show/hide capture loader modals
  function showCapturePrompt() {
    // Reset PiP launcher state
    pipAlreadyLaunched = false;
    btnLaunchPip.disabled = false;
    btnLaunchPip.querySelector('span').textContent = 'Launch Floating Webcam';
    pipStatus.classList.remove('active');
    pipStatusText.textContent = 'Webcam PiP not started';

    // Show PiP section only when mode is screencam + pip overlay
    chrome.storage.local.get('recordingConfig', (data) => {
      cachedConfig = data.recordingConfig || {};
      if (cachedConfig.mode === 'screencam' && cachedConfig.overlayType === 'pip') {
        pipLauncherSection.classList.remove('hidden');
      } else {
        pipLauncherSection.classList.add('hidden');
      }
    });

    capturePromptOverlay.classList.remove('hidden');
  }

  function hideCapturePrompt() {
    capturePromptOverlay.classList.add('hidden');
  }

  // Core capture engine
  async function startRecordingFlow() {
    hideCapturePrompt();
    recordedChunks = [];
    baseDuration = 0;
    
    try {
      // 1. Fetch current config from storage
      const data = await chrome.storage.local.get('recordingConfig');
      const config = data.recordingConfig || { mode: 'screencam', recordSystemAudio: true };
      
      console.log('Starting record flow with config:', config);

      // 2. PiP window is launched by the user directly via btnLaunchPip (user gesture)
      // so we do NOT call openPipWindow() here to avoid losing the gesture context
      
      // 3. Request Screen Capture stream
      const displayConstraints = {
        video: {
          cursor: "always"
        },
        audio: config.recordSystemAudio ? {
          echoCancellation: true,
          noiseSuppression: true
        } : false
      };

      screenStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
      
      // 4. Request microphone stream if enabled
      if (config.mode !== 'screen' && config.micId !== 'none') {
        const micConstraints = {
          audio: config.micId && config.micId !== 'default' ? { deviceId: { exact: config.micId } } : true
        };
        try {
          micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
        } catch (micErr) {
          console.warn('Microphone access denied or unavailable, recording screen only:', micErr);
          alert('Microphone was not accessible. Starting screen-only recording instead.');
        }
      }

      // 5. Mix Audio Tracks (Mic + System Audio) using AudioContext
      const audioTracks = [];
      const hasSystemAudio = screenStream.getAudioTracks().length > 0;
      const hasMicAudio = micStream && micStream.getAudioTracks().length > 0;

      if (hasSystemAudio || hasMicAudio) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioDestination = audioContext.createMediaStreamDestination();

        if (hasSystemAudio) {
          const sysSource = audioContext.createMediaStreamSource(new MediaStream([screenStream.getAudioTracks()[0]]));
          sysSource.connect(audioDestination);
        }

        if (hasMicAudio) {
          const micSource = audioContext.createMediaStreamSource(new MediaStream([micStream.getAudioTracks()[0]]));
          micSource.connect(audioDestination);
        }

        audioTracks.push(audioDestination.stream.getAudioTracks()[0]);
      }

      // 6. Combine mixed Audio + Screen Video into a single Stream
      const combinedTracks = [screenStream.getVideoTracks()[0], ...audioTracks];
      const mixedStream = new MediaStream(combinedTracks);

      // 7. Instantiate MediaRecorder
      // Choose optimal mimeType for Chrome WebM encoding
      let options = { mimeType: 'video/webm;codecs=vp9,opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm;codecs=vp8,opus' };
      }
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm' };
      }

      mediaRecorder = new MediaRecorder(mixedStream, options);

      // Set recording chunks listener
      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      // Set recording stop listener
      mediaRecorder.onstop = () => {
        compileAndSaveRecording();
      };

      // Handle user stopping stream from standard Chrome bar
      screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        console.log('Screen sharing stopped via Chrome panel');
        stopRecordingFlow();
      });

      // 8. Start recording
      mediaRecorder.start(1000); // chunk slices every 1s
      recordingStartTime = Date.now();
      lastResumeTime = recordingStartTime;
      baseDuration = 0;

      // 9. Update state in background and storage
      const recordState = {
        status: 'recording',
        startTime: recordingStartTime,
        lastResumeTime: lastResumeTime,
        baseDuration: baseDuration,
        options: config
      };
      
      chrome.runtime.sendMessage({
        action: 'RECORDING_STATE_CHANGED',
        status: 'recording',
        startTime: recordingStartTime,
        options: config
      });

      // Show floating camera/controls overlay in the active page
      // (The background script handles injecting it when recording state changes)
      
      // Also show local webcam overlay bubble on the dashboard if screen + bubble is selected
      createLocalWidget();
      
    } catch (err) {
      console.error('Failed to capture stream:', err);
      cleanupStreams();
      alert('Recording cancelled or failed: ' + err.message);
    }
  }

  function pauseRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      
      // Toggle local widget controls UI
      if (localWidgetRoot) {
        localWidgetRoot.querySelector('.auracast-btn-pause')?.classList.add('auracast-hidden');
        localWidgetRoot.querySelector('.auracast-btn-resume')?.classList.remove('auracast-hidden');
        localWidgetRoot.classList.add('auracast-recording-paused');
      }

      // Calculate elapsed time before pause
      const timeSinceLastResume = Date.now() - lastResumeTime;
      baseDuration += timeSinceLastResume;
      
      chrome.runtime.sendMessage({
        action: 'RECORDING_STATE_CHANGED',
        status: 'paused',
        startTime: recordingStartTime,
        accumulatedTime: baseDuration
      });
      
      // Update local tracker
      chrome.storage.local.get('recordingState', (res) => {
        if (res.recordingState) {
          const updated = res.recordingState;
          updated.status = 'paused';
          updated.baseDuration = baseDuration;
          updated.accumulatedTime = baseDuration;
          chrome.storage.local.set({ recordingState: updated });
        }
      });
    }
  }

  function resumeRecording() {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      lastResumeTime = Date.now();

      // Toggle local widget controls UI
      if (localWidgetRoot) {
        localWidgetRoot.querySelector('.auracast-btn-resume')?.classList.add('auracast-hidden');
        localWidgetRoot.querySelector('.auracast-btn-pause')?.classList.remove('auracast-hidden');
        localWidgetRoot.classList.remove('auracast-recording-paused');
      }

      chrome.runtime.sendMessage({
        action: 'RECORDING_STATE_CHANGED',
        status: 'recording',
        startTime: recordingStartTime
      });

      chrome.storage.local.get('recordingState', (res) => {
        if (res.recordingState) {
          const updated = res.recordingState;
          updated.status = 'recording';
          updated.lastResumeTime = lastResumeTime;
          chrome.storage.local.set({ recordingState: updated });
        }
      });
    }
  }

  function stopRecordingFlow() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  function toggleMicMute(muted) {
    if (micStream && micStream.getAudioTracks().length > 0) {
      micStream.getAudioTracks()[0].enabled = !muted;
      console.log('Microphone track muted state changed to:', muted);
    }
  }

  // Compile final chunks into file and write to DB
  async function compileAndSaveRecording() {
    console.log('Compiling video...');
    const videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
    
    // Calculate final duration
    let finalDuration = baseDuration;
    if (mediaRecorder.state !== 'paused' && lastResumeTime) {
      finalDuration += (Date.now() - lastResumeTime);
    }
    
    // Clean up streams first
    cleanupStreams();

    // Reset state in background
    chrome.runtime.sendMessage({
      action: 'RECORDING_STATE_CHANGED',
      status: 'idle',
      startTime: null
    });

    // Save overlay toggle settings to closed
    chrome.storage.local.set({ webcamBubbleActive: false });
    chrome.runtime.sendMessage({ action: 'CLOSE_CAMERA_BUBBLE' });

    // Generate nice title
    const dateObj = new Date();
    const title = `Recording - ${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    
    // Generate thumbnail
    const thumbnail = await generateVideoThumbnail(videoBlob);

    // Save to DB
    const recording = {
      title,
      blob: videoBlob,
      thumbnail,
      duration: finalDuration,
      size: videoBlob.size,
      date: dateObj.getTime()
    };

    saveRecordingToDB(recording)
      .then((id) => {
        loadRecordings();
        updateStorageUsage();
        // Automatically open the saved recording in our player!
        openPlayerModal(id);
      })
      .catch((err) => {
        console.error('Error saving recording to IDB:', err);
        alert('Failed to save recording locally: ' + err.message);
      });
  }

  function cleanupStreams() {
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
    }
    if (pipCamStream) {
      pipCamStream.getTracks().forEach(track => track.stop());
      pipCamStream = null;
      const pipCamVideo = document.getElementById('pipCamVideo');
      if (pipCamVideo) {
        pipCamVideo.srcObject = null;
      }
    }
    if (pipWindow && document.pictureInPictureElement) {
      try {
        document.exitPictureInPicture();
      } catch (e) {
        // Already exited
      }
      pipWindow = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    audioDestination = null;
    mediaRecorder = null;
    lastResumeTime = null;
    baseDuration = 0;
    
    // Clean up local webcam widget
    removeLocalWidget();
  }

  // Opens a floating always-on-top webcam using standard video PiP API
  async function openPipWindow(config) {
    try {
      const camConstraints = {
        video: {
          width: { ideal: 480 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
          facingMode: 'user'
        },
        audio: false
      };

      if (config.cameraId && config.cameraId !== 'default' && config.cameraId !== 'none') {
        camConstraints.video.deviceId = { exact: config.cameraId };
      }

      // Get webcam stream
      pipCamStream = await navigator.mediaDevices.getUserMedia(camConstraints);

      // Hook stream to the hidden video element in dashboard.html
      const pipCamVideo = document.getElementById('pipCamVideo');
      pipCamVideo.srcObject = pipCamStream;

      // Wait for video to be ready before requesting PiP
      await new Promise((resolve, reject) => {
        pipCamVideo.onloadedmetadata = resolve;
        pipCamVideo.onerror = reject;
        setTimeout(reject, 5000); // safety timeout
      });

      await pipCamVideo.play();

      // Check if PiP is supported
      if (!document.pictureInPictureEnabled) {
        console.warn('Standard PiP is not supported or enabled in this browser.');
        return;
      }

      // Launch Picture-in-Picture — this works without a direct gesture
      // because the video is already playing
      await pipCamVideo.requestPictureInPicture();

      // Track the PiP element for cleanup
      pipWindow = pipCamVideo;

      // When user closes PiP via its own UI
      pipCamVideo.addEventListener('leavepictureinpicture', () => {
        pipWindow = null;
      }, { once: true });

    } catch (err) {
      console.error('Failed to open PiP webcam:', err);
      // Silently fall back — the in-page bubble will still work
      console.warn('Falling back to in-page bubble overlay.');
      throw err;
    }
  } // end openPipWindow

  // Thumbnail generator from video blob
  function generateVideoThumbnail(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      
      // Seek to 1 second in video to avoid a blank frame
      video.currentTime = 0.5;
      
      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl);
        } catch (e) {
          console.warn('Canvas thumbnail capture blocked by cors or layout:', e);
          resolve(''); // Default fallback
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      video.onerror = () => {
        resolve(''); // Fallback
        URL.revokeObjectURL(url);
      };
    });
  }

  // IndexedDB operations
  function saveRecordingToDB(recording) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.add(recording);
      
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  function getRecordingFromDB(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  function getAllRecordingsFromDB() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  function deleteRecordingFromDB(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e.target.error);
    });
  }

  function renameRecordingInDB(id, newTitle) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      
      store.get(id).onsuccess = (e) => {
        const data = e.target.result;
        if (data) {
          data.title = newTitle;
          const reqUpdate = store.put(data);
          reqUpdate.onsuccess = () => resolve();
          reqUpdate.onerror = (err) => reject(err.target.error);
        } else {
          reject(new Error('Record not found'));
        }
      };
    });
  }

  // Load and Render Videos
  function loadRecordings() {
    if (!db) return;

    getAllRecordingsFromDB().then((recordings) => {
      // Sort: Newest first
      recordings.sort((a, b) => b.date - a.date);

      videoGrid.innerHTML = '';
      
      if (recordings.length === 0) {
        emptyState.classList.remove('hidden');
        videosCountLabel.innerText = '0 recordings saved';
        return;
      }

      emptyState.classList.add('hidden');
      videosCountLabel.innerText = `${recordings.length} recording${recordings.length > 1 ? 's' : ''} saved`;

      recordings.forEach((video) => {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.setAttribute('data-id', video.id);

        const formattedDate = new Date(video.date).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
        
        const formattedSize = formatBytes(video.size);
        const formattedDuration = formatDuration(video.duration);

        // Fallback thumbnail if none is captured
        const thumbnailSrc = video.thumbnail || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="%231a153b"/><circle cx="160" cy="100" r="24" fill="%236366f1" opacity="0.3"/><path d="M153,90 L173,100 L153,110 Z" fill="%23ffffff"/></svg>`;

        card.innerHTML = `
          <div class="video-card-thumbnail-wrapper">
            <img class="video-card-thumbnail" src="${thumbnailSrc}" alt="Video thumbnail" loading="lazy">
            <div class="video-card-play-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </div>
            <span class="video-card-duration">${formattedDuration}</span>
          </div>
          <div class="video-card-info">
            <h3 class="video-card-title" title="${video.title}">${video.title}</h3>
            <div class="video-card-meta">
              <span>${formattedDate}</span>
              <span>${formattedSize}</span>
            </div>
          </div>
          <div class="video-card-actions">
            <button class="card-action-btn btn-download" title="Download Video">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              <span>Get</span>
            </button>
            <button class="card-action-btn btn-delete" title="Delete Recording">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              <span>Delete</span>
            </button>
          </div>
        `;

        // Event listener for play click
        card.querySelector('.video-card-thumbnail-wrapper').addEventListener('click', () => {
          openPlayerModal(video.id);
        });
        
        card.querySelector('.video-card-title').addEventListener('click', () => {
          openPlayerModal(video.id);
        });

        // Event listener for action buttons
        card.querySelector('.btn-download').addEventListener('click', (e) => {
          e.stopPropagation();
          downloadVideo(video);
        });

        card.querySelector('.btn-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm('Are you sure you want to delete this recording?')) {
            deleteVideo(video.id);
          }
        });

        videoGrid.appendChild(card);
      });
    });
  }

  // Action methods
  function downloadVideo(video) {
    const url = URL.createObjectURL(video.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${video.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Revoke object URL after click delay
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function deleteVideo(id) {
    deleteRecordingFromDB(id).then(() => {
      loadRecordings();
      updateStorageUsage();
      if (currentPlayerVideoId === id) {
        closePlayerModal();
      }
    });
  }

  // Player Modal Controller
  function openPlayerModal(id) {
    getRecordingFromDB(id).then((video) => {
      if (!video) return;

      currentPlayerVideoId = id;
      
      // Clean up previous source
      if (playerElement.src) {
        URL.revokeObjectURL(playerElement.src);
      }

      const blobUrl = URL.createObjectURL(video.blob);
      playerElement.src = blobUrl;
      
      // Fill Details
      playerVideoTitle.value = video.title;
      
      const formattedDate = new Date(video.date).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      playerStatDate.innerText = `Created: ${formattedDate}`;
      playerStatSize.innerText = `Size: ${formatBytes(video.size)}`;
      
      // Hook up download link
      btnPlayerDownload.href = blobUrl;
      btnPlayerDownload.download = `${video.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.webm`;

      // Set up Delete button click (needs clean replacement to prevent multiple listeners accumulation)
      const oldDelete = btnPlayerDelete.cloneNode(true);
      btnPlayerDelete.parentNode.replaceChild(oldDelete, btnPlayerDelete);
      document.getElementById('btnPlayerDelete').addEventListener('click', () => {
        if (confirm('Are you sure you want to delete this recording?')) {
          deleteVideo(id);
          closePlayerModal();
        }
      });

      playerModalOverlay.classList.remove('hidden');
      playerElement.play();
    });
  }

  function closePlayerModal() {
    playerElement.pause();
    if (playerElement.src) {
      URL.revokeObjectURL(playerElement.src);
      playerElement.removeAttribute('src');
      playerElement.load();
    }
    currentPlayerVideoId = null;
    playerModalOverlay.classList.add('hidden');
  }

  function savePlayerVideoTitle() {
    if (currentPlayerVideoId) {
      const newTitle = playerVideoTitle.value.trim() || 'Untitled recording';
      renameRecordingInDB(currentPlayerVideoId, newTitle).then(() => {
        loadRecordings();
        btnSaveTitle.style.color = '#10b981'; // Green flash on success
        setTimeout(() => btnSaveTitle.style.color = '', 1500);
      });
    }
  }

  // Calculate local disk storage usage
  function updateStorageUsage() {
    if (!db) return;
    
    getAllRecordingsFromDB().then((recordings) => {
      let totalBytes = 0;
      recordings.forEach(video => totalBytes += video.size);
      
      const totalMB = totalBytes / (1024 * 1024);
      storageText.innerText = `${totalMB.toFixed(1)} MB`;
      
      // Est limit of 500MB quota for quick dashboard visual warning
      const estLimit = 500;
      const fillPercent = Math.min(100, (totalMB / estLimit) * 100);
      storageBarFill.style.width = `${fillPercent}%`;
      
      if (fillPercent > 80) {
        storageBarFill.style.background = 'var(--red-alert)';
      } else {
        storageBarFill.style.background = 'var(--accent-gradient)';
      }
    });
  }

  // Formatter helpers
  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDuration(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // Local Webcam Widget Creation and Draggable management for Dashboard page
  function createLocalWidget() {
    if (localWidgetRoot) return;

    // We only show it if config.mode is screencam and overlayType is bubble
    chrome.storage.local.get('recordingConfig', (res) => {
      const config = res.recordingConfig || {};
      if (config.mode !== 'screencam' || config.overlayType !== 'bubble') {
        return;
      }

      // Link content.css dynamically if not already linked
      if (!document.getElementById('auracast-content-css')) {
        const link = document.createElement('link');
        link.id = 'auracast-content-css';
        link.rel = 'stylesheet';
        link.href = 'content.css';
        document.head.appendChild(link);
      }

      localWidgetRoot = document.createElement('div');
      localWidgetRoot.id = 'auracast-widget-root';
      localWidgetRoot.className = 'auracast-size-medium';
      localWidgetRoot.style.left = '30px';
      localWidgetRoot.style.bottom = '30px';

      localCamBubble = document.createElement('div');
      localCamBubble.id = 'auracast-cam-bubble';

      const iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'camera; microphone');
      iframe.src = 'camera.html';
      iframe.id = 'auracast-cam-iframe';
      
      localCamBubble.appendChild(iframe);

      const dragOverlay = document.createElement('div');
      dragOverlay.className = 'auracast-drag-overlay';
      localCamBubble.appendChild(dragOverlay);

      localControlBar = document.createElement('div');
      localControlBar.id = 'auracast-control-bar';

      localTimerEl = document.createElement('div');
      localTimerEl.className = 'auracast-control-timer';
      localTimerEl.innerText = '00:00';
      localControlBar.appendChild(localTimerEl);

      // Pause/Resume Button
      const btnPause = document.createElement('button');
      btnPause.className = 'auracast-control-btn auracast-btn-pause';
      btnPause.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="6" y="4" width="4" height="16" />
          <rect x="14" y="4" width="4" height="16" />
        </svg>
      `;
      btnPause.title = 'Pause Recording';
      
      const btnResume = document.createElement('button');
      btnResume.className = 'auracast-control-btn auracast-btn-resume auracast-hidden';
      btnResume.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,3 19,12 5,21" />
        </svg>
      `;
      btnResume.title = 'Resume Recording';

      btnPause.addEventListener('click', () => {
        pauseRecording();
      });

      btnResume.addEventListener('click', () => {
        resumeRecording();
      });

      localControlBar.appendChild(btnPause);
      localControlBar.appendChild(btnResume);

      // Stop Button
      const btnStop = document.createElement('button');
      btnStop.className = 'auracast-control-btn auracast-btn-stop';
      btnStop.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      `;
      btnStop.title = 'Stop & Save';
      btnStop.addEventListener('click', () => {
        stopRecordingFlow();
      });
      localControlBar.appendChild(btnStop);

      localWidgetRoot.appendChild(localCamBubble);
      localWidgetRoot.appendChild(localControlBar);
      document.body.appendChild(localWidgetRoot);

      // Drag and drop setup for dashboard
      setupLocalDragging();
      startLocalTimer();
    });
  }

  function removeLocalWidget() {
    if (localTimerInterval) {
      clearInterval(localTimerInterval);
      localTimerInterval = null;
    }
    if (localWidgetRoot) {
      localWidgetRoot.remove();
      localWidgetRoot = null;
      localCamBubble = null;
      localControlBar = null;
      localTimerEl = null;
    }
  }

  function startLocalTimer() {
    const updateLocalClock = () => {
      if (localTimerEl) {
        let totalElapsed = Date.now() - recordingStartTime;
        if (baseDuration) {
          totalElapsed = baseDuration + (mediaRecorder && mediaRecorder.state === 'recording' ? (Date.now() - lastResumeTime) : 0);
        }
        const totalSecs = Math.floor(totalElapsed / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        localTimerEl.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
    };
    updateLocalClock();
    localTimerInterval = setInterval(updateLocalClock, 1000);
  }

  function setupLocalDragging() {
    let isDragging = false;
    let startX, startY, widgetX, widgetY;

    const dragStart = (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = localWidgetRoot.getBoundingClientRect();
      widgetX = rect.left;
      widgetY = rect.top;
      localWidgetRoot.classList.add('auracast-dragging');
    };

    const drag = (e) => {
      if (!isDragging) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let x = widgetX + dx;
      let y = widgetY + dy;
      
      const padding = 15;
      const rect = localWidgetRoot.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - padding;
      const maxY = window.innerHeight - rect.height - padding;
      
      x = Math.max(padding, Math.min(x, maxX));
      y = Math.max(padding, Math.min(y, maxY));
      
      localWidgetRoot.style.left = `${x}px`;
      localWidgetRoot.style.top = `${y}px`;
      localWidgetRoot.style.bottom = 'auto';
    };

    const dragEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      localWidgetRoot.classList.remove('auracast-dragging');
    };

    localCamBubble.addEventListener('mousedown', dragStart);
    
    // Touch support for dragging
    localCamBubble.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) dragStart(e.touches[0]);
    });
    window.addEventListener('mousemove', drag);
    window.addEventListener('touchmove', (e) => {
      if (isDragging && e.touches.length === 1) drag(e.touches[0]);
    });
    window.addEventListener('mouseup', dragEnd);
    window.addEventListener('touchend', dragEnd);
  }
});
