// AuraCast Webcam Capture Controller

const video = document.getElementById('webcamVideo');
const placeholderOverlay = document.getElementById('placeholderOverlay');
const placeholderText = document.getElementById('placeholderText');
let activeStream = null;

// Initialize camera feed
initCamera();

// Listen for settings changes to update camera source dynamically
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.recordingConfig) {
    const newConfig = changes.recordingConfig.newValue;
    const oldConfig = changes.recordingConfig.oldValue;
    
    // Check if camera settings or mode changed
    if (!oldConfig || newConfig.cameraId !== oldConfig.cameraId || newConfig.mode !== oldConfig.mode) {
      initCamera();
    }
  }
});

async function initCamera() {
  // Stop existing tracks first
  stopCamera();

  // Load config
  try {
    const data = await chrome.storage.local.get('recordingConfig');
    const config = data.recordingConfig || {};

    if (config.mode === 'screen' || config.cameraId === 'none') {
      showPlaceholder('Webcam is disabled.');
      return;
    }

    showPlaceholder('Connecting to webcam...');

    const deviceId = config.cameraId;
    const constraints = {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: false // We capture audio separately in the recorder dashboard to avoid feedback loops
    };

    if (deviceId && deviceId !== 'default' && deviceId !== 'none') {
      constraints.video.deviceId = { exact: deviceId };
    }

    activeStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = activeStream;
    
    video.onloadedmetadata = async () => {
      try {
        await video.play();
      } catch (playErr) {
        console.error('Failed to play webcam video:', playErr);
      }
      hidePlaceholder();
    };

  } catch (err) {
    console.error('Error starting camera in iframe:', err);
    let errorMsg = 'Failed to access webcam.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      errorMsg = 'Webcam permission denied.\nPlease click the extension popup and allow webcam access.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      errorMsg = 'No webcam device found.';
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      errorMsg = 'Webcam is in use by another app.';
    } else if (err.name === 'OverconstrainedError') {
      errorMsg = 'Webcam constraints not supported.';
    }
    showPlaceholder(errorMsg);
  }
}

function stopCamera() {
  if (activeStream) {
    activeStream.getTracks().forEach(track => track.stop());
    activeStream = null;
  }
  video.srcObject = null;
}

function showPlaceholder(message = 'Webcam is loading...') {
  if (placeholderText) {
    placeholderText.textContent = message;
  }
  placeholderOverlay.classList.remove('hidden');
}

function hidePlaceholder() {
  placeholderOverlay.classList.add('hidden');
}

// Ensure camera resource is cleaned up when page unloads
window.addEventListener('beforeunload', () => {
  stopCamera();
});
